'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { User } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { TimelineFeed, type TimelineDecorations } from './lead-timeline'
import { DEFAULT_PRACTICE_TIMEZONE } from '@/lib/time/zoned'
import type { TimelineEntry } from '@/lib/timeline/types'
import type { ActivityEntry, ActivitySource } from '@/lib/timeline/activity-feed'

const REFRESH_DEBOUNCE_MS = 700

/**
 * Org-wide live activity monitor. Renders every conversation's calls, texts,
 * emails, and notes as one newest-first feed; each event links to the lead's
 * conversation thread.
 *
 * The feed itself comes from the server component (already merged + name-
 * decrypted). This client shell adds two things the server can't: the
 * per-event link/lead-chip decorations, and a realtime subscription that
 * `router.refresh()`es the page when anything new lands — the same
 * refresh-on-insert pattern the per-lead timeline uses, fanned out to the whole
 * org and debounced so a burst of inbound traffic coalesces into one refetch.
 */
export function ActivityMonitor({
  entries,
  orgId,
  timeZone = DEFAULT_PRACTICE_TIMEZONE,
  staffNames,
}: {
  entries: ActivityEntry[]
  orgId: string
  timeZone?: string
  /** staff_user_id → display name, for attributing human-placed calls. */
  staffNames?: Record<string, string>
}) {
  const router = useRouter()

  // Rebuild the Map the renderer wants from the plain object the server passes
  // (Maps aren't serializable across the server/client boundary).
  const userNameById = useMemo(() => new Map(Object.entries(staffNames ?? {})), [staffNames])
  const [live, setLive] = useState(false)

  // Source lookup for the decoration closures, keyed the same way the feed keys
  // its <li> (kind-id). Rebuilt only when the feed changes.
  const sourceByKey = useMemo(() => {
    const m = new Map<string, ActivitySource>()
    for (const e of entries) m.set(`${e.kind}-${e.id}`, e.source)
    return m
  }, [entries])

  const decorations = useMemo<TimelineDecorations>(
    () => ({
      hrefFor: (entry: TimelineEntry) => sourceByKey.get(`${entry.kind}-${entry.id}`)?.href ?? null,
      metaFor: (entry: TimelineEntry) => {
        const name = sourceByKey.get(`${entry.kind}-${entry.id}`)?.leadName
        if (!name) return null
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-aurea-surface-2 px-1.5 py-px text-[10.5px] font-medium text-aurea-ink-2">
            <User className="h-2.5 w-2.5" strokeWidth={2} />
            {name}
          </span>
        )
      },
    }),
    [sourceByKey],
  )

  // Refresh the server feed whenever new activity lands anywhere in the org.
  useEffect(() => {
    const supabase = createClient()
    let timer: ReturnType<typeof setTimeout> | null = null

    const scheduleRefresh = () => {
      setLive(true)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS)
    }

    const filter = `organization_id=eq.${orgId}`
    const channel = supabase
      .channel(`activity-monitor-${orgId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter }, scheduleRefresh)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'voice_calls', filter }, scheduleRefresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'voice_calls', filter }, scheduleRefresh)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'lead_activities', filter }, scheduleRefresh)
      .subscribe()

    return () => {
      if (timer) clearTimeout(timer)
      supabase.removeChannel(channel)
    }
  }, [orgId, router])

  if (entries.length === 0) {
    return (
      <p className="py-20 text-center text-sm text-aurea-ink-3">
        No calls, texts, or notes across the workspace yet.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-[11px] text-aurea-ink-3">
        <span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-aurea-emerald' : 'bg-aurea-border-strong'}`} aria-hidden />
        <span>{live ? 'Live — new activity syncs automatically' : 'Watching for new activity…'}</span>
        <span className="ml-auto tabular-nums">{entries.length} recent events</span>
      </div>
      <TimelineFeed entries={entries} timeZone={timeZone} decorations={decorations} userNameById={userNameById} />
    </div>
  )
}
