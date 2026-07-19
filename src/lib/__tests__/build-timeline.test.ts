import { describe, it, expect } from 'vitest'
import { buildTimeline, TIMELINE_ACTIVITY_TYPES } from '@/lib/timeline/build-timeline'
import type { TimelineInput } from '@/lib/timeline/types'

const empty: TimelineInput = { messages: [], calls: [], activities: [] }

describe('buildTimeline', () => {
  it('returns an empty array when there is nothing', () => {
    expect(buildTimeline(empty)).toEqual([])
  })

  it('maps a message row to a message entry', () => {
    const out = buildTimeline({
      ...empty,
      messages: [{
        id: 'm1', created_at: '2026-06-01T10:00:00.000Z', channel: 'sms', direction: 'inbound',
        body: 'hi', subject: null, status: 'delivered', ai_generated: false, sender_type: 'lead', sender_name: null,
      }],
    })
    expect(out).toEqual([{
      kind: 'message', id: 'm1', at: '2026-06-01T10:00:00.000Z', channel: 'sms', direction: 'inbound',
      body: 'hi', subject: null, status: 'delivered', aiGenerated: false, senderType: 'lead', senderName: null,
    }])
  })

  it('uses started_at for a call, falling back to created_at', () => {
    const out = buildTimeline({
      ...empty,
      calls: [
        { id: 'c1', created_at: '2026-06-01T09:00:00.000Z', started_at: '2026-06-01T09:05:00.000Z', direction: 'outbound', outcome: 'interested', duration_seconds: 120, outcome_notes: 'good chat', transcript_summary: null, recording_url: null, status: 'completed', call_mode: 'browser', agent_type: null, staff_user_id: 'u1' },
        { id: 'c2', created_at: '2026-06-01T08:00:00.000Z', started_at: null, direction: 'inbound', outcome: null, duration_seconds: 0, outcome_notes: null, transcript_summary: null, recording_url: null, status: 'no_answer', call_mode: 'ai', agent_type: 'setter', staff_user_id: null },
      ],
    })
    expect(out.map((e) => e.at)).toEqual(['2026-06-01T08:00:00.000Z', '2026-06-01T09:05:00.000Z'])
    expect(out[1]).toMatchObject({ kind: 'call', id: 'c1', durationSeconds: 120, notes: 'good chat', outcome: 'interested' })
  })

  it('keeps note_added and stage_changed activities, ignoring other activity types', () => {
    const out = buildTimeline({
      ...empty,
      activities: [
        { id: 'a1', created_at: '2026-06-01T10:00:00.000Z', activity_type: 'note_added', title: 'Note', description: 'called back later' },
        { id: 'a2', created_at: '2026-06-01T11:00:00.000Z', activity_type: 'stage_changed', title: 'Moved to Qualified', description: null },
        { id: 'a3', created_at: '2026-06-01T12:00:00.000Z', activity_type: 'score_updated', title: 'Score 80', description: 'ignored' },
      ],
    })
    expect(out.map((e) => e.kind)).toEqual(['note', 'stage_change'])
    expect(out[0]).toMatchObject({ kind: 'note', body: 'called back later' })
  })

  // Regression: /leads/[id] used to fetch the 50 most recent activities of ANY
  // type and let buildTimeline filter afterwards. With 29 activity types, a busy
  // lead's notes and stage changes fell outside that window and the Timeline view
  // rendered empty. The fix filters in the query; these two tests pin the pieces
  // that make the fix hold.
  describe('activity-type starvation regression', () => {
    it('exposes the query filter the builder actually honours, so the two cannot drift', () => {
      // If someone teaches buildTimeline a new activity kind but forgets to widen
      // the query filter, the new kind is silently never fetched. Pinning the
      // constant here makes that omission a failing test rather than a blank feed.
      expect([...TIMELINE_ACTIVITY_TYPES].sort()).toEqual(['note_added', 'stage_changed'])
    })

    it('still surfaces a note buried under a flood of newer high-volume activities', () => {
      // Mirrors the production shape: one old note, then 60 newer score updates.
      // Pre-fix, a .limit(50) on created_at DESC returned only score_updated rows
      // and this note was gone before the builder ever saw it.
      const note = {
        id: 'note-1',
        created_at: '2026-06-01T08:00:00.000Z',
        activity_type: 'note_added',
        title: 'Note',
        description: 'patient asked about financing',
      }
      const noise = Array.from({ length: 60 }, (_, i) => ({
        id: `score-${i}`,
        created_at: `2026-06-02T${String(i % 24).padStart(2, '0')}:00:00.000Z`,
        activity_type: 'score_updated',
        title: 'Score updated',
        description: null,
      }))

      // The query now hands the builder only the timeline-relevant types, in the
      // same order Postgres would. The note survives.
      const fetched = [...noise, note].filter((a) =>
        (TIMELINE_ACTIVITY_TYPES as readonly string[]).includes(a.activity_type),
      )
      const out = buildTimeline({ ...empty, activities: fetched })

      expect(out).toHaveLength(1)
      expect(out[0]).toMatchObject({ kind: 'note', body: 'patient asked about financing' })
    })
  })

  it('interleaves channels in ascending time order, tie-breaking by id', () => {
    const out = buildTimeline({
      messages: [
        { id: 'm2', created_at: '2026-06-01T10:00:00.000Z', channel: 'email', direction: 'outbound', body: 'b', subject: 'Hi', status: 'sent', ai_generated: true, sender_type: 'ai', sender_name: 'AI' },
        { id: 'm1', created_at: '2026-06-01T10:00:00.000Z', channel: 'sms', direction: 'inbound', body: 'a', subject: null, status: 'read', ai_generated: false, sender_type: 'lead', sender_name: null },
      ],
      calls: [{ id: 'c1', created_at: '2026-06-01T09:00:00.000Z', started_at: '2026-06-01T09:00:00.000Z', direction: 'outbound', outcome: null, duration_seconds: 30, outcome_notes: null, transcript_summary: null, recording_url: null, status: 'completed', call_mode: 'ai', agent_type: 'closer', staff_user_id: null }],
      activities: [],
    })
    expect(out.map((e) => e.id)).toEqual(['c1', 'm1', 'm2'])
  })
})
