/**
 * Human-paced outbound SMS drain.
 *
 * Sends AI SMS replies whose scheduled send_at has passed (see send-pacing.ts +
 * the pending_outbound_sms table). Enqueued only when an org has the
 * `sms_human_pacing` flag ON, so with the flag off this cron simply finds no due
 * rows and no-ops — safe to schedule before the feature is enabled anywhere.
 *
 * Schedule: every minute (vercel.json). Heartbeats via withCron.
 */
import { withCron } from '@/lib/cron/with-cron'
import { drainDeferredSms } from '@/lib/messaging/send-pacing'

export const POST = withCron('drain-outbound-sms', async ({ supabase }) => {
  const result = await drainDeferredSms(supabase, { limit: 100 })
  return {
    status: result.failed > 0 && result.sent === 0 ? 'failed' : 'ok',
    items: result.sent,
    data: { scanned: result.scanned, sent: result.sent, failed: result.failed },
  }
})

// Vercel Cron invokes cron routes with a GET request; alias it to the POST
// handler so this scheduled route actually runs (matches every other cron route).
export const GET = POST
