# Unified Timeline (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render one chronological call + text + email + note feed per lead in a new "Channel" tab, and let staff log calls manually so "call" is real data.

**Architecture:** A pure `buildTimeline()` function merges already-fetched `messages`, `voice_calls`, and `lead_activities` rows into a sorted `TimelineEntry[]` (unit-tested with no DB mocks, matching the repo's pure-function test style). The lead detail server page fetches the raw rows, builds the timeline server-side, and passes it to a new client `<LeadTimeline>` component. Manual calls are logged via a new `POST /api/leads/[id]/calls` route that writes a `voice_calls` row + a `lead_activities` row, reusing the exact patterns in `src/app/api/sms/send/route.ts`.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Supabase, vitest, shadcn/ui, Tailwind, lucide-react.

---

## Pre-work (read before writing any route/component code)

Per `AGENTS.md`, this repo runs a **modified Next.js 16**. Before Tasks 4, 5, 6, 7, 8, skim:
- `node_modules/next/dist/docs/` — route handlers (`app/api/**/route.ts`) and async `params`, and server vs. client components.

Confirm the route-handler signature uses `params: Promise<{ id: string }>` and `await params` (matches `src/app/(dashboard)/leads/[id]/page.tsx`).

## File structure (locked)

- Create: `src/lib/timeline/types.ts` — `TimelineEntry` union + `TimelineInput`.
- Create: `src/lib/timeline/build-timeline.ts` — pure merge/sort.
- Create: `src/lib/timeline/manual-call.ts` — pure `buildManualCallRows()`.
- Create: `src/lib/__tests__/build-timeline.test.ts` — vitest.
- Create: `src/lib/__tests__/manual-call.test.ts` — vitest.
- Create: `src/app/api/leads/[id]/calls/route.ts` — POST manual call log.
- Create: `src/components/crm/log-call-dialog.tsx` — client dialog.
- Create: `src/components/crm/lead-timeline.tsx` — client feed + action bar.
- Modify: `src/app/(dashboard)/leads/[id]/page.tsx` — fetch messages + voice_calls, build timeline, pass down.
- Modify: `src/components/crm/lead-detail.tsx` — add `timeline` prop + "Channel" tab.

---

### Task 1: TimelineEntry types

**Files:**
- Create: `src/lib/timeline/types.ts`

- [ ] **Step 1: Create the types file**

```ts
// src/lib/timeline/types.ts
import type { Message, VoiceCall, LeadActivity } from '@/types/database'

/** A single, normalized item in a lead's unified channel feed. */
export type TimelineEntry =
  | {
      kind: 'message'
      id: string
      at: string
      channel: Message['channel']
      direction: Message['direction']
      body: string
      subject: string | null
      status: Message['status']
      aiGenerated: boolean
      senderType: Message['sender_type']
      senderName: string | null
    }
  | {
      kind: 'call'
      id: string
      at: string
      direction: VoiceCall['direction']
      outcome: VoiceCall['outcome']
      durationSeconds: number
      notes: string | null
      transcriptSummary: string | null
      recordingUrl: string | null
      status: VoiceCall['status']
    }
  | { kind: 'note'; id: string; at: string; title: string; body: string }
  | { kind: 'stage_change'; id: string; at: string; title: string; body: string | null }

/** Raw rows the timeline builder consumes (already org-scoped by the caller). */
export interface TimelineInput {
  messages: Pick<
    Message,
    'id' | 'created_at' | 'channel' | 'direction' | 'body' | 'subject' | 'status' | 'ai_generated' | 'sender_type' | 'sender_name'
  >[]
  calls: Pick<
    VoiceCall,
    'id' | 'created_at' | 'started_at' | 'direction' | 'outcome' | 'duration_seconds' | 'outcome_notes' | 'transcript_summary' | 'recording_url' | 'status'
  >[]
  activities: Pick<LeadActivity, 'id' | 'created_at' | 'activity_type' | 'title' | 'description'>[]
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no errors from the new file).

- [ ] **Step 3: Commit**

```bash
git add src/lib/timeline/types.ts
git commit -m "feat(timeline): TimelineEntry + TimelineInput types"
```

---

### Task 2: buildTimeline (pure merge/sort) — TDD

**Files:**
- Create: `src/lib/timeline/build-timeline.ts`
- Test: `src/lib/__tests__/build-timeline.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/build-timeline.test.ts
import { describe, it, expect } from 'vitest'
import { buildTimeline } from '@/lib/timeline/build-timeline'
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
        { id: 'c1', created_at: '2026-06-01T09:00:00.000Z', started_at: '2026-06-01T09:05:00.000Z', direction: 'outbound', outcome: 'interested', duration_seconds: 120, outcome_notes: 'good chat', transcript_summary: null, recording_url: null, status: 'completed' },
        { id: 'c2', created_at: '2026-06-01T08:00:00.000Z', started_at: null, direction: 'inbound', outcome: null, duration_seconds: 0, outcome_notes: null, transcript_summary: null, recording_url: null, status: 'no_answer' },
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

  it('interleaves channels in ascending time order, tie-breaking by id', () => {
    const out = buildTimeline({
      messages: [
        { id: 'm2', created_at: '2026-06-01T10:00:00.000Z', channel: 'email', direction: 'outbound', body: 'b', subject: 'Hi', status: 'sent', ai_generated: true, sender_type: 'ai', sender_name: 'AI' },
        { id: 'm1', created_at: '2026-06-01T10:00:00.000Z', channel: 'sms', direction: 'inbound', body: 'a', subject: null, status: 'read', ai_generated: false, sender_type: 'lead', sender_name: null },
      ],
      calls: [{ id: 'c1', created_at: '2026-06-01T09:00:00.000Z', started_at: '2026-06-01T09:00:00.000Z', direction: 'outbound', outcome: null, duration_seconds: 30, outcome_notes: null, transcript_summary: null, recording_url: null, status: 'completed' }],
      activities: [],
    })
    expect(out.map((e) => e.id)).toEqual(['c1', 'm1', 'm2'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/build-timeline.test.ts`
Expected: FAIL — "Cannot find module '@/lib/timeline/build-timeline'".

- [ ] **Step 3: Implement the builder**

```ts
// src/lib/timeline/build-timeline.ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/__tests__/build-timeline.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/timeline/build-timeline.ts src/lib/__tests__/build-timeline.test.ts
git commit -m "feat(timeline): pure buildTimeline merge/sort with tests"
```

---

### Task 3: buildManualCallRows (pure) — TDD

**Files:**
- Create: `src/lib/timeline/manual-call.ts`
- Test: `src/lib/__tests__/manual-call.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/manual-call.test.ts
import { describe, it, expect } from 'vitest'
import { buildManualCallRows, type ManualCallInput } from '@/lib/timeline/manual-call'

const base: ManualCallInput = {
  orgId: 'org-1', leadId: 'lead-1', userId: 'user-1',
  direction: 'outbound', outcome: 'interested', durationSeconds: 90,
  notes: 'Discussed financing', nowIso: '2026-07-01T15:00:00.000Z',
}

describe('buildManualCallRows', () => {
  it('builds a completed outbound voice_calls row with a call_made activity', () => {
    const { voiceCall, activity } = buildManualCallRows(base)
    expect(voiceCall).toMatchObject({
      organization_id: 'org-1', lead_id: 'lead-1', direction: 'outbound', status: 'completed',
      from_number: 'manual-entry', to_number: 'manual-entry', duration_seconds: 90,
      started_at: '2026-07-01T15:00:00.000Z', ended_at: '2026-07-01T15:00:00.000Z',
      outcome: 'interested', outcome_notes: 'Discussed financing', consent_verified: true,
    })
    expect(activity).toMatchObject({
      organization_id: 'org-1', lead_id: 'lead-1', user_id: 'user-1',
      activity_type: 'call_made', description: 'Discussed financing',
    })
  })

  it('uses call_received for inbound direction', () => {
    const { activity } = buildManualCallRows({ ...base, direction: 'inbound' })
    expect(activity.activity_type).toBe('call_received')
  })

  it('tolerates null outcome and notes', () => {
    const { voiceCall, activity } = buildManualCallRows({ ...base, outcome: null, notes: null })
    expect(voiceCall.outcome).toBeNull()
    expect(voiceCall.outcome_notes).toBeNull()
    expect(activity.description).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/manual-call.test.ts`
Expected: FAIL — "Cannot find module '@/lib/timeline/manual-call'".

- [ ] **Step 3: Implement the helper**

```ts
// src/lib/timeline/manual-call.ts
import type { VoiceCallOutcome } from '@/types/database'

export interface ManualCallInput {
  orgId: string
  leadId: string
  userId: string | null
  direction: 'inbound' | 'outbound'
  outcome: VoiceCallOutcome | null
  durationSeconds: number
  notes: string | null
  nowIso: string
}

export interface ManualCallRows {
  voiceCall: Record<string, unknown>
  activity: Record<string, unknown>
}

/**
 * Map a manual call-log request into the two rows we persist: a completed
 * `voice_calls` row and a `lead_activities` audit row. Numbers are stored as a
 * 'manual-entry' placeholder (the NOT NULL columns are satisfied without
 * implying real telephony — Phase 2 wires transcription/real numbers).
 */
export function buildManualCallRows(input: ManualCallInput): ManualCallRows {
  const voiceCall = {
    organization_id: input.orgId,
    lead_id: input.leadId,
    direction: input.direction,
    status: 'completed',
    from_number: 'manual-entry',
    to_number: 'manual-entry',
    duration_seconds: input.durationSeconds,
    started_at: input.nowIso,
    ended_at: input.nowIso,
    outcome: input.outcome,
    outcome_notes: input.notes,
    consent_verified: true,
    metadata: { source: 'manual_log' },
  }

  const activity = {
    organization_id: input.orgId,
    lead_id: input.leadId,
    user_id: input.userId,
    activity_type: input.direction === 'outbound' ? 'call_made' : 'call_received',
    title: input.direction === 'outbound' ? 'Call logged (outbound)' : 'Call logged (inbound)',
    description: input.notes,
  }

  return { voiceCall, activity }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/__tests__/manual-call.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/timeline/manual-call.ts src/lib/__tests__/manual-call.test.ts
git commit -m "feat(timeline): pure buildManualCallRows helper with tests"
```

---

### Task 4: POST /api/leads/[id]/calls route

**Files:**
- Create: `src/app/api/leads/[id]/calls/route.ts`

(Consult `node_modules/next/dist/docs/` route-handler guide first — see Pre-work.)

- [ ] **Step 1: Implement the route**

```ts
// src/app/api/leads/[id]/calls/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { buildManualCallRows } from '@/lib/timeline/manual-call'

const logCallSchema = z.object({
  direction: z.enum(['inbound', 'outbound']),
  duration_seconds: z.number().int().min(0).max(86_400).default(0),
  outcome: z
    .enum([
      'appointment_booked', 'callback_requested', 'interested', 'not_interested',
      'wrong_number', 'do_not_call', 'voicemail_left', 'no_answer',
      'technical_failure', 'transferred',
    ])
    .nullish()
    .transform((v) => v ?? null),
  notes: z.string().max(2000).nullish().transform((v) => v ?? null),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id')
    .single()
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = logCallSchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  // Scope the lead to the caller's org (defense-in-depth beyond RLS).
  const { data: lead } = await supabase
    .from('leads')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()
  if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })

  const { voiceCall, activity } = buildManualCallRows({
    orgId,
    leadId: lead.id,
    userId: profile.id,
    direction: parsed.data.direction,
    outcome: parsed.data.outcome,
    durationSeconds: parsed.data.duration_seconds,
    notes: parsed.data.notes,
    nowIso: new Date().toISOString(),
  })

  const { data: call, error: callError } = await supabase
    .from('voice_calls')
    .insert(voiceCall)
    .select('id')
    .single()
  if (callError || !call) {
    return NextResponse.json({ error: 'Failed to log call' }, { status: 500 })
  }

  await supabase.from('lead_activities').insert(activity)
  await supabase.from('leads').update({ last_contacted_at: new Date().toISOString() }).eq('id', lead.id)

  return NextResponse.json({ ok: true, call_id: call.id })
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/leads/[id]/calls/route.ts"
git commit -m "feat(timeline): POST /api/leads/[id]/calls manual call logging"
```

---

### Task 5: Log-call dialog component

**Files:**
- Create: `src/components/crm/log-call-dialog.tsx`

- [ ] **Step 1: Implement the dialog**

```tsx
// src/components/crm/log-call-dialog.tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Phone, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

const OUTCOMES = [
  { value: 'interested', label: 'Interested' },
  { value: 'appointment_booked', label: 'Appointment booked' },
  { value: 'callback_requested', label: 'Callback requested' },
  { value: 'not_interested', label: 'Not interested' },
  { value: 'no_answer', label: 'No answer' },
  { value: 'voicemail_left', label: 'Voicemail left' },
  { value: 'wrong_number', label: 'Wrong number' },
  { value: 'do_not_call', label: 'Do not call' },
] as const

export function LogCallDialog({ leadId }: { leadId: string }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [direction, setDirection] = useState<'outbound' | 'inbound'>('outbound')
  const [outcome, setOutcome] = useState<string>('interested')
  const [minutes, setMinutes] = useState('')
  const [notes, setNotes] = useState('')
  const router = useRouter()

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(`/api/leads/${leadId}/calls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          direction,
          outcome,
          duration_seconds: Math.round((parseFloat(minutes) || 0) * 60),
          notes: notes.trim() || null,
        }),
      })
      if (!res.ok) throw new Error('Save failed')
      toast.success('Call logged')
      setMinutes('')
      setNotes('')
      setOpen(false)
      router.refresh()
    } catch {
      toast.error('Failed to log call')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger>
        <span className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-aurea-border px-3 py-2 text-sm font-medium text-aurea-ink transition-colors hover:bg-aurea-surface-2">
          <Phone className="h-4 w-4" strokeWidth={1.75} />
          Log Call
        </span>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="aurea-display text-[22px] text-aurea-ink">Log a call</DialogTitle>
        </DialogHeader>

        <div className="mt-2 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-aurea-ink-3">Direction</Label>
              <Select value={direction} onValueChange={(v) => v && setDirection(v as 'outbound' | 'inbound')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="outbound">Outbound</SelectItem>
                  <SelectItem value="inbound">Inbound</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-aurea-ink-3">Duration (min)</Label>
              <Input type="number" min="0" step="0.5" value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="0" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-aurea-ink-3">Outcome</Label>
            <Select value={outcome} onValueChange={(v) => v && setOutcome(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {OUTCOMES.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-aurea-ink-3">Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was discussed?" rows={4} />
          </div>
        </div>

        <div className="mt-3 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" strokeWidth={1.75} />}
            Log call
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/crm/log-call-dialog.tsx
git commit -m "feat(timeline): manual Log Call dialog"
```

---

### Task 6: LeadTimeline feed component

**Files:**
- Create: `src/components/crm/lead-timeline.tsx`

Reuses the existing `<LeadMessaging>` composer (SMS/email + AI draft) and the new `<LogCallDialog>` for the action bar — no duplicate composer.

- [ ] **Step 1: Implement the component**

```tsx
// src/components/crm/lead-timeline.tsx
'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { Card, CardContent } from '@/components/ui/card'
import { LeadMessaging } from './lead-messaging'
import { LogCallDialog } from './log-call-dialog'
import { MessageSquare, Mail, Phone, StickyNote, GitBranch } from 'lucide-react'
import type { Lead } from '@/types/database'
import type { TimelineEntry } from '@/lib/timeline/types'

const CHANNEL_ICON = {
  sms: MessageSquare,
  whatsapp: MessageSquare,
  web_chat: MessageSquare,
  email: Mail,
  voice: Phone,
} as const

function labelFor(entry: TimelineEntry): string {
  if (entry.kind === 'message') return entry.channel === 'email' ? 'Email' : 'SMS'
  if (entry.kind === 'call') return `Call · ${entry.direction}${entry.outcome ? ` · ${entry.outcome.replace(/_/g, ' ')}` : ''}`
  if (entry.kind === 'note') return 'Note'
  return 'Stage change'
}

function IconFor({ entry }: { entry: TimelineEntry }) {
  if (entry.kind === 'message') {
    const Icon = CHANNEL_ICON[entry.channel] ?? MessageSquare
    return <Icon className="h-4 w-4" strokeWidth={1.75} />
  }
  if (entry.kind === 'call') return <Phone className="h-4 w-4" strokeWidth={1.75} />
  if (entry.kind === 'note') return <StickyNote className="h-4 w-4" strokeWidth={1.75} />
  return <GitBranch className="h-4 w-4" strokeWidth={1.75} />
}

export function LeadTimeline({ lead, entries }: { lead: Lead; entries: TimelineEntry[] }) {
  const router = useRouter()

  // Live-refresh when a new message arrives for this lead.
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`lead-timeline-${lead.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `lead_id=eq.${lead.id}` },
        () => router.refresh()
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [lead.id, router])

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <LeadMessaging lead={lead} />
        <LogCallDialog leadId={lead.id} />
      </div>

      {entries.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-aurea-ink-3">
            No calls, texts, or emails yet. Use the actions above to start the conversation.
          </CardContent>
        </Card>
      ) : (
        <ol className="space-y-3">
          {entries.map((entry) => {
            const outbound = (entry.kind === 'message' || entry.kind === 'call') && entry.direction === 'outbound'
            return (
              <li key={`${entry.kind}-${entry.id}`} className={outbound ? 'flex justify-end' : 'flex justify-start'}>
                <div className={`max-w-[80%] rounded-lg border border-aurea-border px-3 py-2 ${outbound ? 'bg-aurea-surface-2' : 'bg-aurea-surface'}`}>
                  <div className="mb-1 flex items-center gap-1.5 text-xs text-aurea-ink-3">
                    <IconFor entry={entry} />
                    <span>{labelFor(entry)}</span>
                    <span>·</span>
                    <span>{formatDistanceToNow(new Date(entry.at), { addSuffix: true })}</span>
                    {entry.kind === 'message' && entry.aiGenerated && <span className="rounded bg-aurea-border/40 px-1">AI</span>}
                  </div>
                  {entry.kind === 'message' && (
                    <>
                      {entry.subject && <p className="text-sm font-medium text-aurea-ink">{entry.subject}</p>}
                      <p className="whitespace-pre-wrap text-sm text-aurea-ink-2">{entry.body}</p>
                    </>
                  )}
                  {entry.kind === 'call' && (
                    <p className="text-sm text-aurea-ink-2">
                      {entry.durationSeconds > 0 && <span>{Math.round(entry.durationSeconds / 60)} min. </span>}
                      {entry.notes ?? entry.transcriptSummary ?? 'No notes.'}
                    </p>
                  )}
                  {(entry.kind === 'note' || entry.kind === 'stage_change') && (
                    <p className="whitespace-pre-wrap text-sm text-aurea-ink-2">{entry.body || entry.title}</p>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS. (If `@/lib/supabase/client` export differs, adjust the import to the repo's browser client factory — grep `src/lib/supabase/client.ts` for the exported name.)

- [ ] **Step 3: Commit**

```bash
git add src/components/crm/lead-timeline.tsx
git commit -m "feat(timeline): LeadTimeline unified feed with realtime refresh"
```

---

### Task 7: Fetch messages + voice_calls and build the timeline in the page

**Files:**
- Modify: `src/app/(dashboard)/leads/[id]/page.tsx`

- [ ] **Step 1: Add the import (top of file, after existing imports)**

```ts
import { buildTimeline } from '@/lib/timeline/build-timeline'
```

- [ ] **Step 2: Add the two fetches after the existing conversations fetch (after line ~40)**

```ts
  // Fetch messages (all channels) for the unified timeline
  const { data: messages } = await supabase
    .from('messages')
    .select('id, created_at, channel, direction, body, subject, status, ai_generated, sender_type, sender_name')
    .eq('lead_id', id)
    .order('created_at', { ascending: true })
    .limit(300)

  // Fetch logged voice calls for the unified timeline
  const { data: voiceCalls } = await supabase
    .from('voice_calls')
    .select('id, created_at, started_at, direction, outcome, duration_seconds, outcome_notes, transcript_summary, recording_url, status')
    .eq('lead_id', id)
    .order('created_at', { ascending: true })
    .limit(300)

  const timeline = buildTimeline({
    messages: messages || [],
    calls: voiceCalls || [],
    activities: activities || [],
  })
```

- [ ] **Step 3: Pass `timeline` into `<LeadDetail>`**

Change the JSX return to add the prop:

```tsx
  return (
    <LeadDetail
      lead={lead}
      activities={activities || []}
      conversations={conversations || []}
      timeline={timeline}
      stages={stages || []}
      teamMembers={teamMembers || []}
    />
  )
```

- [ ] **Step 4: Typecheck (will fail until Task 8 adds the prop)**

Run: `npx tsc --noEmit`
Expected: FAIL — `LeadDetail` has no `timeline` prop yet. Proceed to Task 8, then re-run.

- [ ] **Step 5: Commit (deferred)** — commit together with Task 8 since the two changes are interdependent.

---

### Task 8: Add the "Channel" tab in LeadDetail

**Files:**
- Modify: `src/components/crm/lead-detail.tsx`

- [ ] **Step 1: Add imports (with the other imports near the top)**

```ts
import { LeadTimeline } from './lead-timeline'
import type { TimelineEntry } from '@/lib/timeline/types'
```

- [ ] **Step 2: Add `timeline` to the component props**

In the destructured params (around line 51-56) add `timeline,` and in the prop type (around line 57-61) add `timeline: TimelineEntry[]`:

```tsx
export function LeadDetail({
  lead: initialLead,
  activities,
  conversations,
  timeline,
  stages,
  teamMembers,
}: {
  lead: Lead
  activities: LeadActivity[]
  conversations: Conversation[]
  timeline: TimelineEntry[]
  stages: PipelineStage[]
  teamMembers: UserProfile[]
```

- [ ] **Step 3: Add the tab trigger + content**

At the `TabsList` (around line 222-228), add a trigger as the second item:

```tsx
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="channel">Channel</TabsTrigger>
              <TabsTrigger value="conversations">
```

Immediately after the `overview` `TabsContent` closes (around line 295), add:

```tsx
            <TabsContent value="channel" className="mt-4">
              <LeadTimeline lead={lead} entries={timeline} />
            </TabsContent>
```

(`lead` is the local state variable already used in this component for the live lead; if the local variable is named `initialLead` only, use the state variable that the component renders elsewhere — grep the file for `lead.first_name` to confirm the in-scope name and match it.)

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (Task 7 + Task 8 together resolve the prop).

- [ ] **Step 5: Commit Tasks 7 + 8 together**

```bash
git add "src/app/(dashboard)/leads/[id]/page.tsx" src/components/crm/lead-detail.tsx
git commit -m "feat(timeline): Channel tab renders unified call/text/email feed"
```

---

### Task 9: Full verification

- [ ] **Step 1: Run the whole test suite**

Run: `npm run test`
Expected: PASS, including the new `build-timeline` and `manual-call` suites.

- [ ] **Step 2: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: PASS (repo rule: tsc errors fail the Vercel build on main).

- [ ] **Step 3: Manual verification**

Run: `npm run dev` (serves on port 3001). Open a lead at `/leads/<id>`, click the **Channel** tab. Confirm: existing SMS/email messages appear interleaved oldest→newest; **Log Call** writes a call entry that appears after refresh; **Send Message** still works and its message shows in the feed.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: no new errors from the added files (pre-existing repo lint debt is non-blocking).

---

## Self-review notes

- **Spec coverage:** This plan implements Layer A (Unified Timeline) only — the foundation. Layers B/C/D are out of scope by design (separate plans after Phase 1 ships).
- **Types consistency:** `buildTimeline` / `TimelineInput` / `TimelineEntry` names match across Tasks 1, 2, 6, 7, 8. `buildManualCallRows` / `ManualCallInput` match across Tasks 3 and 4.
- **No placeholders:** every code step is complete. The two "grep to confirm the exact local name / client export" notes are verification hints, not missing code — the shown code is correct against the files inspected on 2026-07-01.
