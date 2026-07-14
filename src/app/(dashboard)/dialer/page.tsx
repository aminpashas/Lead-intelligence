import { redirect } from 'next/navigation'

/**
 * The Power Dialer folded into the Call Center hub (2026-07) as its "Power Dialer"
 * tab — one calling surface instead of two competing nav slots. This route is kept
 * (not deleted) so old bookmarks and links keep working and the call_center:read gate
 * in ROUTE_PERMISSION_MAP still covers the path; it simply forwards to the tab, which
 * enforces the same gate and now owns the queue.
 */
export default function DialerPage() {
  redirect('/call-center?tab=dialer')
}
