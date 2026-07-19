import type { TimelineEntry, TimelineInput } from './types'

const NOTE_ACTIVITY = 'note_added'
const STAGE_ACTIVITY = 'stage_changed'

/**
 * The only `lead_activities` types this feed renders. Callers MUST filter on
 * these in the query itself — filtering after a `.limit()` lets high-volume
 * activity types starve notes and stage changes out of the result set.
 */
export const TIMELINE_ACTIVITY_TYPES = [NOTE_ACTIVITY, STAGE_ACTIVITY] as const

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
      callMode: c.call_mode ?? null,
      agentType: c.agent_type ?? null,
      staffUserId: c.staff_user_id ?? null,
    })
  }

  // Only notes and stage changes come from activities. Call activities
  // (call_made/call_received) are deliberately skipped: a manual call log writes
  // BOTH a voice_calls row and a lead_activities audit row, and the call is
  // already rendered above off voice_calls — admitting it here would show the
  // same call twice.
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
