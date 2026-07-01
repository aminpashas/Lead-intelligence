import type { TimelineEntry, TimelineInput } from './types'

const NOTE_ACTIVITY = 'note_added'
const STAGE_ACTIVITY = 'stage_changed'

/**
 * Merge a lead's messages, voice calls, and select activities into one
 * time-ascending feed (oldest first). Pure — the caller fetches org-scoped rows.
 * Ties on timestamp are broken by id for deterministic ordering.
 */
export function buildTimeline(input: TimelineInput): TimelineEntry[] {
  const entries: TimelineEntry[] = []

  for (const m of input.messages) {
    entries.push({
      kind: 'message',
      id: m.id,
      at: m.created_at,
      channel: m.channel,
      direction: m.direction,
      body: m.body,
      subject: m.subject ?? null,
      status: m.status,
      aiGenerated: Boolean(m.ai_generated),
      senderType: m.sender_type,
      senderName: m.sender_name ?? null,
    })
  }

  for (const c of input.calls) {
    entries.push({
      kind: 'call',
      id: c.id,
      at: c.started_at ?? c.created_at,
      direction: c.direction,
      outcome: c.outcome ?? null,
      durationSeconds: c.duration_seconds ?? 0,
      notes: c.outcome_notes ?? null,
      transcriptSummary: c.transcript_summary ?? null,
      recordingUrl: c.recording_url ?? null,
      status: c.status,
    })
  }

  for (const a of input.activities) {
    if (a.activity_type === NOTE_ACTIVITY) {
      entries.push({ kind: 'note', id: a.id, at: a.created_at, title: a.title, body: a.description ?? '' })
    } else if (a.activity_type === STAGE_ACTIVITY) {
      entries.push({ kind: 'stage_change', id: a.id, at: a.created_at, title: a.title, body: a.description ?? null })
    }
  }

  return entries.sort((x, y) =>
    x.at < y.at ? -1 : x.at > y.at ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0
  )
}
