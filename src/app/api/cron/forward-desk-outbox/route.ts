/**
 * Dion Desk outbox forwarder.
 *
 * Drains public.dion_desk_outbox (existing-patient inbound contacts handed from
 * LI to Dion Desk) to Desk's bus receiver. No-op until DION_DESK_URL +
 * DION_BUS_SECRET are set, so it is safe to run while Desk is still being
 * provisioned — rows simply stay 'pending' and buffer.
 *
 * Schedule: every 10 minutes (vercel.json). Heartbeats via withCron.
 */
import { withCron } from '@/lib/cron/with-cron'
import { forwardDeskOutbox } from '@/lib/bridges/dion-desk'

export const POST = withCron('forward-desk-outbox', async ({ supabase }) => {
  const result = await forwardDeskOutbox(supabase, { limit: 200 })
  if (result.skipped) {
    return { status: 'skipped', items: 0, data: { reason: 'desk_not_configured' } }
  }
  return {
    status: result.failed > 0 && result.sent === 0 ? 'failed' : 'ok',
    items: result.sent,
    data: { scanned: result.scanned, sent: result.sent, failed: result.failed },
  }
})
