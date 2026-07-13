/**
 * Deep conversation-analysis backfill (Insights panel restore).
 *
 * The Lead Intelligence panel's "Conversation Analysis" section reads the
 * `conversation_analyses` table (deep tone/engagement/coaching/HIPAA row written
 * by the on-demand Analyze button via `analyzeConversation`). Historically every
 * such write failed silently — the table had no `unique(conversation_id)` target
 * for the upsert's ON CONFLICT, so Postgres threw 42P10 and the analyze route
 * swallowed it into a stream error. The row was shown live but never persisted;
 * on reload the panel section was "gone". The separate patient-psychology write
 * (keyed on lead_id, which already had its constraint) survived — so the tell is
 * a lead with a `patient_profiles` row but NO `conversation_analyses` row.
 *
 * The unique constraint is now in place, so new analyses persist. This route
 * restores the leads that lost theirs: it re-runs the deep analyst for every lead
 * that WAS analyzed before (has a patient_profiles row) but has no
 * conversation_analyses row yet. It deliberately does NOT deep-analyze the cold
 * book — the deep analyst stays reserved for on-demand + this targeted restore.
 *
 * Resumability comes for free: `analyzeConversation` upserts a conversation_analyses
 * row on success, so a restored lead drops out of the candidate set on the next
 * tick. Re-running never redoes work.
 *
 * Safety:
 *   • Gated by env DEEP_ANALYSIS_BACKFILL_ENABLED=1. Unset ⇒ every tick no-ops.
 *   • `?dryRun=1` counts remaining candidates per org and spends ZERO tokens.
 *   • Per-tick + per-org caps and a timeout guard keep each run bounded. The deep
 *     analyst is Sonnet — keep caps conservative.
 */

import { withCron } from '@/lib/cron/with-cron'
import { analyzeConversation } from '@/lib/ai/conversation-analyst'
import { pickConversationToAnalyze } from '@/lib/timeline/pick-conversation'

/** Each lead is a heavyweight Sonnet call; take the full budget. */
export const maxDuration = 300

/** Leads to restore per org per tick — Sonnet is pricey, keep this small. */
const MAX_LEADS_PER_ORG = 15
/** Candidate profiles to pull per org (we restore up to MAX_LEADS_PER_ORG). */
const CANDIDATE_FETCH = 200
const MAX_MESSAGES_PER_CONVERSATION = 60

export const POST = withCron('backfill-deep-analysis', async ({ request, supabase }) => {
  const dryRun = new URL(request.url).searchParams.get('dryRun') === '1'

  if (!dryRun && process.env.DEEP_ANALYSIS_BACKFILL_ENABLED !== '1') {
    return {
      status: 'skipped',
      items: 0,
      data: { message: 'DEEP_ANALYSIS_BACKFILL_ENABLED not set — pass ?dryRun=1 to count remaining work' },
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

  // A candidate = a lead that was analyzed before (has a patient_profiles row)
  // but has no conversation_analyses row yet. Computed per org by subtracting the
  // set of already-restored lead_ids from the set of analyzed lead_ids.
  async function candidateLeadIds(orgId: string): Promise<string[]> {
    const { data: profiles } = await supabase
      .from('patient_profiles')
      .select('lead_id')
      .eq('organization_id', orgId)
      .not('lead_id', 'is', null)
      .limit(CANDIDATE_FETCH)

    const profileRows = (profiles || []) as Array<{ lead_id: string | null }>
    const profileLeadIds = [
      ...new Set(profileRows.map((p) => p.lead_id).filter((id): id is string => !!id)),
    ]
    if (profileLeadIds.length === 0) return []

    const { data: existing } = await supabase
      .from('conversation_analyses')
      .select('lead_id')
      .eq('organization_id', orgId)
      .in('lead_id', profileLeadIds)

    const existingRows = (existing || []) as Array<{ lead_id: string | null }>
    const done = new Set(existingRows.map((r) => r.lead_id).filter((id): id is string => !!id))
    return profileLeadIds.filter((id) => !done.has(id))
  }

  // ── Dry run: count-only, no model calls. ─────────────────────────────────────
  if (dryRun) {
    const perOrg: Array<{ organization_id: string; remaining: number }> = []
    let remaining = 0
    for (const org of orgs) {
      const ids = await candidateLeadIds(org.id)
      perOrg.push({ organization_id: org.id, remaining: ids.length })
      remaining += ids.length
    }
    return { status: 'ok', items: 0, data: { dry_run: true, remaining, organizations: perOrg } }
  }

  let totalRestored = 0
  let totalSkipped = 0
  let totalErrors = 0
  const orgResults: Array<{
    organization_id: string
    candidates: number
    restored: number
    skipped: number
    errors: number
  }> = []

  for (const org of orgs) {
    // Stop starting new orgs when close to the timeout; the next tick resumes.
    if (Date.now() - startedAt > (maxDuration - 60) * 1000) break

    const candidates = await candidateLeadIds(org.id)
    if (candidates.length === 0) {
      orgResults.push({ organization_id: org.id, candidates: 0, restored: 0, skipped: 0, errors: 0 })
      continue
    }

    let restored = 0
    let skipped = 0
    let errors = 0

    for (const leadId of candidates.slice(0, MAX_LEADS_PER_ORG)) {
      if (Date.now() - startedAt > (maxDuration - 30) * 1000) break

      try {
        const { data: lead } = await supabase
          .from('leads')
          .select('*')
          .eq('id', leadId)
          .eq('organization_id', org.id)
          .single()
        if (!lead) {
          skipped++
          continue
        }

        // Pick the same conversation the panel would analyze on demand, so the
        // restored row matches what a manual re-Analyze would produce.
        const { data: conversations } = await supabase
          .from('conversations')
          .select('id, message_count, last_message_at, status')
          .eq('lead_id', leadId)
          .eq('organization_id', org.id)

        const conversationId = pickConversationToAnalyze(conversations || [])
        if (!conversationId) {
          // No analyzable conversation — nothing to restore. Cheap (no LLM call);
          // it just won't produce a row. Rare, since these leads were analyzed before.
          skipped++
          continue
        }

        const { data: msgs } = await supabase
          .from('messages')
          .select('direction, body, sender_type, created_at')
          .eq('conversation_id', conversationId)
          .eq('organization_id', org.id)
          .order('created_at', { ascending: true })
          .limit(MAX_MESSAGES_PER_CONVERSATION)

        const messages = (msgs || []) as Array<{
          direction: string
          body: string
          sender_type: string
          created_at: string
        }>
        if (messages.length < 2) {
          skipped++
          continue
        }

        // Writes (upserts) the conversation_analyses row; throws on persist failure.
        await analyzeConversation(supabase, {
          organization_id: org.id,
          lead_id: leadId,
          conversation_id: conversationId,
          lead,
          messages,
        })
        restored++
      } catch (err) {
        errors++
        console.error(`[backfill-deep-analysis] lead ${leadId}:`, err instanceof Error ? err.message : err)
      }
    }

    totalRestored += restored
    totalSkipped += skipped
    totalErrors += errors
    orgResults.push({
      organization_id: org.id,
      candidates: candidates.length,
      restored,
      skipped,
      errors,
    })
  }

  return {
    status: totalErrors > 0 && totalRestored === 0 ? 'failed' : 'ok',
    items: totalRestored,
    data: {
      total_restored: totalRestored,
      total_skipped: totalSkipped,
      total_errors: totalErrors,
      organizations: orgResults,
    },
  }
})

export const GET = POST
