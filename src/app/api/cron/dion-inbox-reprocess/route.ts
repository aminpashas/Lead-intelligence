import { withCron } from '@/lib/cron/with-cron'
import { safeParseConsumedEvent } from '@/lib/bridges/dion/consumed'
import { dispatchConsumedEvent } from '@/lib/bridges/dion/dispatch'

/**
 * Reprocess Dion bus events that /api/bus/receive recorded but couldn't process
 * inline — a transient brief-pull or DB failure leaves the dion_inbox row with
 * processed_at null + process_error set. The receiver 200s the hub regardless
 * (so the hub doesn't redeliver-then-dedupe into a black hole); this cron is the
 * durable retry that eventually lands the follow-up brief once Dion Clinical /
 * the network recovers.
 *
 * Auth + heartbeat via withCron (CRON_SECRET). Bounded per run.
 */
export const maxDuration = 120

const BATCH = 100

const handler = withCron('dion-inbox-reprocess', async ({ supabase }) => {
  const { data: pending, error } = await supabase
    .from('dion_inbox')
    .select('id, payload')
    .is('processed_at', null)
    .order('received_at', { ascending: true })
    .limit(BATCH)
  if (error) throw new Error(error.message)

  const counts = { processed: 0, still_failing: 0, discarded: 0 }
  for (const row of pending ?? []) {
    // Re-validate the stored envelope (guards against a schema drift since receipt).
    const parsed = safeParseConsumedEvent(row.payload)
    if (!parsed.success) {
      counts.discarded++
      await supabase
        .from('dion_inbox')
        .update({ processed_at: new Date().toISOString(), process_error: 'no longer in consumed catalog' })
        .eq('id', row.id)
      continue
    }
    try {
      await dispatchConsumedEvent(supabase, parsed.data)
      await supabase
        .from('dion_inbox')
        .update({ processed_at: new Date().toISOString(), process_error: null })
        .eq('id', row.id)
      counts.processed++
    } catch (err) {
      counts.still_failing++
      const message = err instanceof Error ? err.message : 'reprocess failed'
      await supabase.from('dion_inbox').update({ process_error: message }).eq('id', row.id)
    }
  }

  const items = (pending ?? []).length
  return { status: items ? 'ok' : 'skipped', items, data: counts }
})

export const GET = handler
export const POST = handler
