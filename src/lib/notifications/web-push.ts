/**
 * Web Push delivery (Workstream D5)
 *
 * Thin wrapper around the `web-push` VAPID library:
 *   - reads VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT from env
 *   - no-ops (with a warning) when the keys are unset, so environments
 *     without push configured never break a notification path
 *   - sends to EVERY subscription a user holds (laptop + phone)
 *   - prunes dead subscriptions in place: a 404/410 from the push service
 *     means the browser dropped the subscription — delete the row
 *
 * Reads/writes push_subscriptions, whose RLS is user-owns-row: callers must
 * pass a service-role client (webhooks/escalation paths already do) so other
 * users' subscriptions are visible.
 */

import webpush from 'web-push'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

export type PushPayload = {
  title: string
  body: string
  /** In-app URL to open on click, e.g. /conversations/<id>. */
  url?: string
  /** Optional tag: same-tag notifications replace each other in the tray. */
  tag?: string
}

let vapidWarned = false

/**
 * Configure the web-push lib from env. Returns false (warn once) when the
 * VAPID keypair isn't set — push becomes a silent no-op.
 */
function ensureVapidConfigured(): boolean {
  const publicKey = process.env.VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  if (!publicKey || !privateKey) {
    if (!vapidWarned) {
      vapidWarned = true
      logger.warn('WebPush: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY unset — push notifications disabled')
    }
    return false
  }
  // Cheap enough to set every call; keeps tests and env rotation simple.
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:support@example.com',
    publicKey,
    privateKey
  )
  return true
}

/** The public key browsers need to subscribe (null when push is unconfigured). */
export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null
}

type SubscriptionRow = {
  id: string
  endpoint: string
  keys: { p256dh?: string; auth?: string } | null
}

/**
 * Send a push notification to every subscription the user holds.
 * Returns the number of successful deliveries. Never throws.
 */
export async function sendPushToUser(
  supabase: SupabaseClient,
  userId: string,
  payload: PushPayload
): Promise<number> {
  if (!ensureVapidConfigured()) return 0

  let sent = 0
  try {
    const { data: subs } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, keys')
      .eq('user_id', userId)

    if (!subs || subs.length === 0) return 0

    const body = JSON.stringify(payload)

    for (const sub of subs as SubscriptionRow[]) {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: {
              p256dh: sub.keys?.p256dh || '',
              auth: sub.keys?.auth || '',
            },
          },
          body,
          { TTL: 60 * 60 } // stale staff pings aren't worth delivering hours later
        )
        sent++
        await supabase
          .from('push_subscriptions')
          .update({ last_success_at: new Date().toISOString() })
          .eq('id', sub.id)
      } catch (err) {
        const statusCode = (err as { statusCode?: number })?.statusCode
        if (statusCode === 404 || statusCode === 410) {
          // Subscription is gone (browser unsubscribed / expired) — prune it.
          await supabase.from('push_subscriptions').delete().eq('id', sub.id)
        } else {
          logger.warn('WebPush: send failed', {
            userId,
            statusCode: statusCode ?? null,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
  } catch (err) {
    logger.warn('WebPush: sendPushToUser failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return sent
}
