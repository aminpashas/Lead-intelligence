/**
 * Conversation Analysis Sweep — hourly.
 *
 * For every active organization:
 *   1. Find leads whose conversations got new messages in the lookback window
 *      and that haven't been analyzed since that latest message.
 *   2. Run the compact sweep analyzer (Haiku) over each lead's most recent
 *      conversation.
 *   3. Persist intent / sentiment / primary objection / red flag onto the lead
 *      so Smart Lists can segment on them (see smart-list-resolver.ts).
 *
 * Per-org cap bounds cost and keeps the run inside the function timeout; the
 * lookback overlap means anything trimmed by the cap is picked up next run.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { analyzeConversationCompact } from '@/lib/ai/conversation-sweep'

export const maxDuration = 300

const LOOKBACK_HOURS = 26
const MAX_LEADS_PER_ORG = 25
const MAX_MESSAGES_PER_CONVERSATION = 60

type RecentMessageRow = {
  lead_id: string | null
  conversation_id: string | null
  created_at: string
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()
  const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString()
  const startedAt = Date.now()

  const { data: orgs } = await supabase
    .from('organizations')
    .select('id')
    .eq('subscription_status', 'active')

  if (!orgs || orgs.length === 0) {
    return NextResponse.json({ message: 'No active organizations', analyzed: 0 })
  }

  let totalAnalyzed = 0
  let totalRedFlags = 0
  const orgResults: Array<{
    organization_id: string
    candidates: number
    analyzed: number
    red_flags: number
    errors: number
  }> = []

  for (const org of orgs) {
    // Stop starting new orgs when we're close to the function timeout; the
    // next hourly run picks up whatever is left (lookback overlaps by 2h).
    if (Date.now() - startedAt > (maxDuration - 60) * 1000) break

    // 1. Leads with recent conversation activity → latest message + conversation.
    const { data: recent } = await supabase
      .from('messages')
      .select('lead_id, conversation_id, created_at')
      .eq('organization_id', org.id)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(2000)

    const latestByLead = new Map<string, { conversationId: string; latestAt: string }>()
    for (const row of (recent || []) as RecentMessageRow[]) {
      if (!row.lead_id || !row.conversation_id) continue
      // rows arrive newest-first, so the first row per lead is its latest.
      if (!latestByLead.has(row.lead_id)) {
        latestByLead.set(row.lead_id, { conversationId: row.conversation_id, latestAt: row.created_at })
      }
    }

    if (latestByLead.size === 0) {
      orgResults.push({ organization_id: org.id, candidates: 0, analyzed: 0, red_flags: 0, errors: 0 })
      continue
    }

    // 2. Skip leads already analyzed after their latest message.
    const leadIds = [...latestByLead.keys()]
    const leadRows: Array<Record<string, unknown> & { id: string; conversation_analyzed_at: string | null }> = []
    for (let i = 0; i < leadIds.length; i += 500) {
      const { data } = await supabase
        .from('leads')
        .select('*')
        .eq('organization_id', org.id)
        .in('id', leadIds.slice(i, i + 500))
      leadRows.push(...((data || []) as typeof leadRows))
    }

    const candidates = leadRows.filter((lead) => {
      const latest = latestByLead.get(lead.id)
      if (!latest) return false
      return !lead.conversation_analyzed_at || lead.conversation_analyzed_at < latest.latestAt
    })

    let analyzed = 0
    let redFlags = 0
    let errors = 0

    for (const lead of candidates.slice(0, MAX_LEADS_PER_ORG)) {
      if (Date.now() - startedAt > (maxDuration - 30) * 1000) break
      const { conversationId } = latestByLead.get(lead.id)!

      try {
        const { data: messages } = await supabase
          .from('messages')
          .select('direction, body, sender_type, created_at')
          .eq('conversation_id', conversationId)
          .order('created_at', { ascending: false })
          .limit(MAX_MESSAGES_PER_CONVERSATION)

        const ordered = (messages || []).reverse()
        if (ordered.length < 2) {
          // Not enough back-and-forth to classify; stamp so we don't retry hourly.
          await supabase
            .from('leads')
            .update({ conversation_analyzed_at: new Date().toISOString() })
            .eq('id', lead.id)
            .eq('organization_id', org.id)
          continue
        }

        const result = await analyzeConversationCompact(supabase, {
          organization_id: org.id,
          lead_id: lead.id,
          conversation_id: conversationId,
          lead,
          messages: ordered as Array<{ direction: string; body: string; sender_type: string; created_at: string }>,
        })

        analyzed++
        if (result.red_flag) redFlags++
      } catch (err) {
        errors++
        console.error(`[analyze-conversations] lead ${lead.id}:`, err instanceof Error ? err.message : err)
      }
    }

    totalAnalyzed += analyzed
    totalRedFlags += redFlags
    orgResults.push({
      organization_id: org.id,
      candidates: candidates.length,
      analyzed,
      red_flags: redFlags,
      errors,
    })
  }

  return NextResponse.json({
    success: true,
    lookback_hours: LOOKBACK_HOURS,
    total_analyzed: totalAnalyzed,
    total_red_flags: totalRedFlags,
    organizations: orgResults,
  })
}

// Vercel cron makes GET requests by default; alias to POST handler.
export const GET = POST
