'use client'

import { useEffect, useState } from 'react'

/**
 * Notification-badge counts for the left nav, keyed by route href.
 *
 * Backed by GET /api/notifications/badges (the `nav_badge_counts` RPC). Fetched
 * once on mount and refreshed on a slow interval; a failed fetch just leaves the
 * previous counts in place. The badge is a courtesy — it never throws and never
 * blocks navigation.
 *
 * Shared by the desktop Sidebar and the mobile BottomNav so both stay in sync.
 */
export type NavBadgeCounts = Record<string, number>

const REFRESH_MS = 60_000

export function useNavBadges(): NavBadgeCounts {
  const [counts, setCounts] = useState<NavBadgeCounts>({})

  useEffect(() => {
    let cancelled = false

    const load = () =>
      fetch('/api/notifications/badges')
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => {
          if (!cancelled && json && typeof json === 'object') {
            setCounts(json as NavBadgeCounts)
          }
        })
        .catch(() => {
          /* courtesy surface — never surface the failure */
        })

    load()
    const t = setInterval(load, REFRESH_MS)

    // Refresh when the tab regains focus so a returning user sees live counts
    // without waiting out the interval.
    const onVisible = () => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return counts
}
