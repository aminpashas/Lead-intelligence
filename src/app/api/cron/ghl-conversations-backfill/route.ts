/**
 * GHL conversation ingestion — chunked cron driver.
 *
 * TWO PHASES, one schedule:
 *   1. BACKFILL — a bounded slice of the one-time historical import per tick,
 *      checkpointing its cursor into connector_configs.settings so it grinds
 *      through the location over many ticks without redoing work.
 *   2. LIVE TAIL — once the backfill reports done, every later tick polls for
 *      conversations newer than a high-water mark (see ghl/poll-conversations).
 *
 * Phase 2 exists because phase 1 alone left a hole that cost six days of data:
 * the backfill marked itself `done` and every subsequent tick no-opped, while
 * the GHL webhook — the only other go-forward path — had silently stopped
 * firing. Nothing alerted, because "no new messages" is indistinguishable from
 * a quiet day. The tail makes pull-based capture self-sustaining, so a webhook
 * outage degrades latency (≤5 min) instead of losing data outright.
 *
 * Opt-in per org via settings.conversation_backfill_enabled (clear
 * settings.conversation_backfill to restart history from scratch).
 */

import { withCron } from '@/lib/cron/with-cron'
import { getGhlConfig } from '@/lib/ghl/client'
import { backfillGhlConversations, type BackfillChunkResult } from '@/lib/ghl/backfill-conversations'
import { pollGhlConversations, type PollResult } from '@/lib/ghl/poll-conversations'

/** Historical paging is slow; give the function the full budget. */
export const maxDuration = 300

/** Conversations to process per tick — conservative to stay within maxDuration. */
const CHUNK = 150

type OrgResult =
  | ({ organization_id: string; phase: 'backfill' } & BackfillChunkResult)
  | ({ organization_id: string; phase: 'tail' } & PollResult)
  | { organization_id: string; phase: 'error'; status: 'skipped' | 'failed'; reason: string }

export const POST = withCron('ghl-conversations-backfill', async ({ supabase }) => {
  const { data: configs } = await supabase
    .from('connector_configs')
    .select('organization_id, settings')
    .eq('connector_type', 'ghl')
    .eq('enabled', true)

  const optedIn = (configs ?? []).filter((c: { settings: Record<string, unknown> | null }) => {
    const s = (c.settings || {}) as Record<string, unknown>
    return s.conversation_backfill_enabled === true
  }) as Array<{ organization_id: string }>

  if (optedIn.length === 0) {
    return { status: 'skipped', items: 0, data: { message: 'No org opted into conversation backfill' } }
  }

  const results: OrgResult[] = []
  for (const org of optedIn) {
    const config = await getGhlConfig(supabase, org.organization_id)
    if (!config) {
      results.push({
        organization_id: org.organization_id,
        phase: 'error',
        status: 'failed',
        reason: 'config_invalid',
      })
      continue
    }
    try {
      const r = await backfillGhlConversations(supabase, org.organization_id, config, {
        maxConversations: CHUNK,
      })
      // 'skipped' means the historical sweep is done — switch to the live tail
      // rather than no-opping forever, which is what blinded LI for six days.
      if (r.status === 'skipped') {
        const p = await pollGhlConversations(supabase, org.organization_id, config)
        results.push({ organization_id: org.organization_id, phase: 'tail', ...p })
      } else {
        results.push({ organization_id: org.organization_id, phase: 'backfill', ...r })
      }
    } catch (err) {
      results.push({
        organization_id: org.organization_id,
        phase: 'error',
        status: 'failed',
        reason: err instanceof Error ? err.message : 'backfill_failed',
      })
    }
  }

  const items = results.reduce((n, r) => n + ('messagesInserted' in r ? r.messagesInserted : 0), 0)
  return { items, data: { orgs: results.length, results } }
})

export const GET = POST
