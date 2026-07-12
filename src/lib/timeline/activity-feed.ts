import { buildTimeline } from './build-timeline'
import type { TimelineEntry, TimelineInput } from './types'

/**
 * Where a global-monitor event came from. The per-conversation timeline never
 * needs this — it's the extra identity that lets an org-wide feed say *who* an
 * event belongs to and *where* clicking it should go.
 */
export interface ActivitySource {
  leadId: string
  /** Decrypted, display-ready name (falls back to phone/email upstream). */
  leadName: string
  /** Owning conversation, when one exists (null for orphan calls/activities). */
  conversationId: string | null
  /** Deep link for the event — the lead's conversation thread, else the lead. */
  href: string
}

/** A timeline node carrying its cross-conversation origin. */
export type ActivityEntry = TimelineEntry & { source: ActivitySource }

/**
 * Merge org-wide messages/calls/activities into one newest-first feed, tagging
 * each node with the lead it belongs to.
 *
 * Reuses {@link buildTimeline} for the row→node mapping so the monitor and the
 * per-conversation timeline stay byte-identical in how they render an event;
 * the only addition is the `source`, matched back by row id. Entries whose id
 * has no source (shouldn't happen — the caller builds the map from the same
 * rows) are dropped rather than rendered as unlinkable orphans.
 */
export function buildActivityFeed(
  input: TimelineInput,
  sourceById: Map<string, ActivitySource>,
): ActivityEntry[] {
  return buildTimeline(input)
    .reduce<ActivityEntry[]>((acc, entry) => {
      const source = sourceById.get(entry.id)
      if (source) acc.push({ ...entry, source })
      return acc
    }, [])
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}
