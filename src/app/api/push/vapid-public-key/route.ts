import { NextResponse } from 'next/server'
import { getVapidPublicKey } from '@/lib/notifications/web-push'

/**
 * GET /api/push/vapid-public-key — the VAPID application server key browsers
 * need to call pushManager.subscribe() (D5).
 *
 * The key is public by design (it ends up in client JS either way), so no
 * auth is required. Returns 404 with a clear message when the environment
 * has no VAPID keypair configured, so the Settings card can explain why the
 * Enable Push button is unavailable.
 */
export async function GET() {
  const publicKey = getVapidPublicKey()
  if (!publicKey) {
    return NextResponse.json(
      { error: 'Push notifications are not configured (VAPID_PUBLIC_KEY unset)' },
      { status: 404 }
    )
  }
  return NextResponse.json({ publicKey })
}
