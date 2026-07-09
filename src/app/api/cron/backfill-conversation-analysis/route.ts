/**
 * Full-history conversation-analysis backfill.
 *
 * The hourly sweep (/api/cron/analyze-conversations) only looks back ~26h, so it
 * classifies conversations as they happen but never touches the historical book.
 * This route grinds through EVERY lead that has a real two-way conversation and
 * has never been analyzed, stamping intent / sentiment / objection / red-flag /
 * summary via the same compact analyzer.
 *
 * Resumability comes for free: `analyzeConversationCompact` stamps
 * `conversation_analyzed_at` on every attempt (even too-short threads, handled
 * below), so each tick simply grabs the next slice of leads where that column is
 * still NULL. Re-running never redoes work and never double-spends tokens.
 *
 * Safety:
 *   • Gated by env CONVERSATION_BACKFILL_ENABLED=1. Unset ⇒ every tick no-ops,
 *     so wiring it into vercel.json is safe; flip the env on to run, off when done.
 *   • `?dryRun=1` counts the remaining candidates per org and spends ZERO tokens —
 *     run this first to see how much work (and cost) is actually left.
 *   • Per-tick + per-org caps and a timeout guard keep each run bounded.
 */

import { withCron } from '@/lib/cron/with-cron'
import { analyzeConversationCompact } from '@/lib/ai/conversation-sweep'

/** Historical paging is slow and each lead is an LLM call; take the full budget. */
export const maxDuration = 300

/** Leads to classify per org per tick — bounds cost and stays inside maxDuration. */
const MAX_LEADS_PER_ORG = 150
/** Candidate leads to pull per org (we analyze up to MAX_LEADS_PER_ORG of them). */
const CANDIDATE_FETCH = 300
const MAX_MESSAGES_PER_CONVERSATION = 60
/** Leads classified concurrently within a tick (bounded to stay under API rate limits). */
const TICK_CONCURRENCY = 6

type CandidateLead = Record<string, unknown> & { id: string }

export const POST = withCron('backfill-conversation-analysis', async ({ request, supabase }) => {
  const dryRun = new URL(request.url).searchParams.get('dryRun') === '1'

  if (!dryRun && process.env.CONVERSATION_BACKFILL_ENABLED !== '1') {
    return {
      status: 'skipped',
      items: 0,
      data: { message: 'CONVERSATION_BACKFILL_ENABLED not set — pass ?dryRun=1 to count remaining work' },
    }
  }

  const startedAt = Date.now()
  const { data: orgs } = await supabase
    .from('organizations')
    .select('id')
    .eq('subscription_status', 'active')

  if (!orgs || orgs.length === 0) {
    return { status: 'skipped', items: 0, data: { message: 'No active organizations' } }
  }

  // ── Dry run: count-only, no model calls. Candidate = has a patient reply
  //    (total_messages_received > 0) and has never been analyzed. ──────────────
  if (dryRun) {
    const perOrg: Array<{ organization_id: string; remaining: number }> = []
    let remaining = 0
    for (const org of orgs) {
      const { count } = await supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', org.id)
        .is('conversation_analyzed_at', null)
        .gt('total_messages_received', 0)
      perOrg.push({ organization_id: org.id, remaining: count ?? 0 })
      remaining += count ?? 0
    }
    return {
      status: 'ok',
      items: 0,
      data: { dry_run: true, remaining, organizations: perOrg },
    }
  }

  let totalAnalyzed = 0
  let totalRedFlags = 0
  let totalErrors = 0
  const orgResults: Array<{
    organization_id: string
    candidates: number
    analyzed: number
    red_flags: number
    errors: number
  }> = []

  for (const org of orgs) {
    // Stop starting new orgs when close to the timeout; the next tick resumes.
    if (Date.now() - startedAt > (maxDuration - 60) * 1000) break

    const { data: candidates } = await supabase
      .from('leads')
      .select('*')
      .eq('organization_id', org.id)
      .is('conversation_analyzed_at', null)
      .gt('total_messages_received', 0)
      .order('created_at', { ascending: true })
      .limit(CANDIDATE_FETCH)

    const list = (candidates || []) as CandidateLead[]
    if (list.length === 0) {
      orgResults.push({ organization_id: org.id, candidates: 0, analyzed: 0, red_flags: 0, errors: 0 })
      continue
    }

    let analyzed = 0
    let redFlags = 0
    let errors = 0

    // Classify one lead's latest conversation. Returns an outcome tag so the
    // concurrent driver below can tally without shared mutable counters.
    const processLead = async (lead: CandidateLead): Promise<'analyzed' | 'analyzed_red' | 'skipped' | 'error'> => {
      try {
        // The lead's most recent conversation (mirror of the hourly sweep, but
        // with no time window — we want the whole history).
        const { data: recent } = await supabase
          .from('messages')
          .select('conversation_id, direction, body, sender_type, created_at')
          .eq('organization_id', org.id)
          .eq('lead_id', lead.id)
          .order('created_at', { ascending: false })
          .limit(MAX_MESSAGES_PER_CONVERSATION)

        const rows = (recent || []) as Array<{
          conversation_id: string | null
          direction: string
          body: string
          sender_type: string
          created_at: string
        }>
        const conversationId = rows.find((r) => r.conversation_id)?.conversation_id ?? null

        // Keep only the latest conversation's messages, in chronological order.
        const ordered = rows
          .filter((r) => r.conversation_id === conversationId)
          .reverse()

        if (!conversationId || ordered.length < 2) {
          // Nothing analyzable — stamp so this lead never re-enters the candidate
          // set (otherwise the backfill would loop on it forever).
          await supabase
            .from('leads')
            .update({ conversation_analyzed_at: new Date().toISOString() })
            .eq('id', lead.id)
            .eq('organization_id', org.id)
          return 'skipped'
        }

        const result = await analyzeConversationCompact(supabase, {
          organization_id: org.id,
          lead_id: lead.id,
          conversation_id: conversationId,
          lead,
          messages: ordered.map((r) => ({
            direction: r.direction,
            body: r.body,
            sender_type: r.sender_type,
            created_at: r.created_at,
          })),
        })

        return result.red_flag ? 'analyzed_red' : 'analyzed'
      } catch (err) {
        console.error(`[backfill-conversation-analysis] lead ${lead.id}:`, err instanceof Error ? err.message : err)
        return 'error'
      }
    }

    // Process the tick's leads in bounded-concurrency chunks — the per-lead work
    // is I/O + a single LLM call, so a small pool cuts wall-clock ~TICK_CONCURRENCY×
    // without risking API rate limits. Timeout guard checked between chunks.
    const toProcess = list.slice(0, MAX_LEADS_PER_ORG)
    for (let i = 0; i < toProcess.length; i += TICK_CONCURRENCY) {
      if (Date.now() - startedAt > (maxDuration - 30) * 1000) break
      const outcomes = await Promise.all(toProcess.slice(i, i + TICK_CONCURRENCY).map(processLead))
      for (const o of outcomes) {
        if (o === 'analyzed' || o === 'analyzed_red') analyzed++
        if (o === 'analyzed_red') redFlags++
        if (o === 'error') errors++
      }
    }

    totalAnalyzed += analyzed
    totalRedFlags += redFlags
    totalErrors += errors
    orgResults.push({
      organization_id: org.id,
      candidates: list.length,
      analyzed,
      red_flags: redFlags,
      errors,
    })
  }

  return {
    status: 'ok',
    items: totalAnalyzed,
    data: {
      total_analyzed: totalAnalyzed,
      total_red_flags: totalRedFlags,
      total_errors: totalErrors,
      organizations: orgResults,
    },
  }
})

export const GET = POST
