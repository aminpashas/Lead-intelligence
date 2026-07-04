/**
 * GHL conversation history backfill — chunked cron driver.
 *
 * Runs a bounded slice of the one-time historical import per tick and checkpoints
 * its cursor into connector_configs.settings, so it grinds through the location's
 * conversations over many ticks without ever redoing work. It is:
 *   • opt-in  — only orgs with settings.conversation_backfill_enabled = true run;
 *   • self-terminating — once the sweep reports done, every later tick no-ops.
 *
 * Flip it on per org by setting connector_configs.settings.conversation_backfill_enabled
 * (and clear settings.conversation_backfill to restart from scratch).
 */

import { withCron } from '@/lib/cron/with-cron'
import { getGhlConfig } from '@/lib/ghl/client'
import { backfillGhlConversations, type BackfillChunkResult } from '@/lib/ghl/backfill-conversations'

/** Historical paging is slow; give the function the full budget. */
export const maxDuration = 300

/** Conversations to process per tick — conservative to stay within maxDuration. */
const CHUNK = 150

type OrgResult =
  | ({ organization_id: string } & BackfillChunkResult)
  | { organization_id: string; status: 'skipped' | 'failed'; reason: string }

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
      results.push({ organization_id: org.organization_id, status: 'failed', reason: 'config_invalid' })
      continue
    }
    try {
      const r = await backfillGhlConversations(supabase, org.organization_id, config, { maxConversations: CHUNK })
      results.push({ organization_id: org.organization_id, ...r })
    } catch (err) {
      results.push({
        organization_id: org.organization_id,
        status: 'failed',
        reason: err instanceof Error ? err.message : 'backfill_failed',
      })
    }
  }

  const items = results.reduce((n, r) => n + ('messagesInserted' in r ? r.messagesInserted : 0), 0)
  return { items, data: { orgs: results.length, results } }
})

export const GET = POST
