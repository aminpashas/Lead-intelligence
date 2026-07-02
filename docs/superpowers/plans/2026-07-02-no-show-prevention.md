# No-Show Prevention & Appointment Stage Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-move the pipeline card through the appointment lifecycle (booked/canceled/no-show), make no-show risk survive confirmation, escalate risky appointments (AI check-in → staff/Slack), and recover no-shows with a rebook nurture.

**Architecture:** Extend the live 15-minute reminders cron with a risk-recompute pass and a tiered escalation pass; one shared stage-mover helper called from every booking path; recovery rides the existing trigger-campaign infrastructure (the `appointment_no_show` trigger event already exists in `TriggerEvent` but nothing fires it yet). Pure decision functions + Vitest unit tests, effectful wrappers fire-and-forget.

**Tech Stack:** Next.js 16 App Router, Supabase (service + auth clients), Twilio via `sendSMSToLead`, Vitest, existing connector dispatcher for Slack.

**Spec:** `docs/superpowers/specs/2026-07-02-no-show-prevention-design.md`

**Branch:** create a fresh worktree/branch off `main` (e.g. `feat/no-show-prevention`) via superpowers:using-git-worktrees. Do NOT build on `feat/online-booking-ehr` (has unrelated in-flight work). Cherry-pick the spec commit `7957f31` or copy the spec file across.

**Verification gate for every task:** `npx tsc --noEmit` must stay green (type errors block the Vercel build on main).

---

### Task 1: Migration + database types

**Files:**
- Create: `supabase/migrations/20260702100000_attendance_escalation.sql`
- Modify: `src/types/database.ts` (the appointments row type — find it by grepping `no_show_risk_score`)

- [ ] **Step 1: Write the migration**

```sql
-- Attendance-escalation tracking for the no-show prevention ladder.
-- Tier 1 = AI morning-of check-in SMS; Tier 2 = staff escalation (queue + Slack).
alter table public.appointments
  add column if not exists escalation_tier smallint,
  add column if not exists escalated_at timestamptz,
  add column if not exists checkin_sent_at timestamptz,
  add column if not exists checkin_replied_at timestamptz;

comment on column public.appointments.escalation_tier is
  'Highest no-show escalation tier reached: 1 = AI check-in sent, 2 = staff escalation fired';
comment on column public.appointments.checkin_sent_at is
  'When the tier-1 morning-of check-in SMS was sent (reply expected within 2h)';
comment on column public.appointments.checkin_replied_at is
  'When the patient replied YES to the tier-1 check-in';
```

- [ ] **Step 2: Add the four fields to the appointments type in `src/types/database.ts`**

Grep for `no_show_risk_score` in `src/types/database.ts` and add alongside it, matching the file's existing style (optional/nullable fields):

```ts
  escalation_tier: number | null
  escalated_at: string | null
  checkin_sent_at: string | null
  checkin_replied_at: string | null
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260702100000_attendance_escalation.sql src/types/database.ts
git commit -m "feat(booking): attendance-escalation columns on appointments"
```

**Note:** Do NOT apply the migration to prod during implementation. Application happens at deploy time via `supabase db query --linked -f supabase/migrations/20260702100000_attendance_escalation.sql` (never `supabase db push` — see memory: same-day filename collisions silently skip siblings).

---

### Task 2: Stage-mover — pure resolver + effectful helper

**Files:**
- Create: `src/lib/pipeline/stage-mover.ts`
- Test: `src/lib/__tests__/stage-mover.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { resolveStageForEvent, type AppointmentStageEvent } from '@/lib/pipeline/stage-mover'
import type { PipelineStage } from '@/types/database'

const stage = (over: Partial<PipelineStage>): PipelineStage =>
  ({
    id: 'x',
    name: 'Stage',
    slug: 'stage',
    position: 0,
    is_won: false,
    is_lost: false,
  }) as PipelineStage

const STAGES: PipelineStage[] = [
  stage({ id: 's-new', name: 'New Leads', slug: 'new', position: 0 }),
  stage({ id: 's-qual', name: 'Qualified', slug: 'qualified', position: 1 }),
  stage({ id: 's-booked', name: 'Consultation Scheduled', slug: 'consultation-scheduled', position: 2 }),
  stage({ id: 's-reeng', name: 'Re-Engage / No-Show', slug: 're-engage', position: 3 }),
  stage({ id: 's-won', name: 'Won', slug: 'won', position: 4, is_won: true }),
  stage({ id: 's-lost', name: 'Lost', slug: 'lost', position: 5, is_lost: true }),
]

describe('resolveStageForEvent', () => {
  it('booked → the consult/scheduled stage', () => {
    const r = resolveStageForEvent(STAGES, 'booked', 's-new')
    expect(r).toEqual({ stage: expect.objectContaining({ id: 's-booked' }) })
  })

  it('no_show and canceled → the re-engage stage', () => {
    for (const event of ['no_show', 'canceled'] as AppointmentStageEvent[]) {
      const r = resolveStageForEvent(STAGES, event, 's-booked')
      expect(r).toEqual({ stage: expect.objectContaining({ id: 's-reeng' }) })
    }
  })

  it('never moves a lead parked in a won/lost stage', () => {
    expect(resolveStageForEvent(STAGES, 'booked', 's-won')).toEqual({ skip: 'won_lost_stage' })
    expect(resolveStageForEvent(STAGES, 'no_show', 's-lost')).toEqual({ skip: 'won_lost_stage' })
  })

  it('no-op when already in the target stage', () => {
    expect(resolveStageForEvent(STAGES, 'booked', 's-booked')).toEqual({ skip: 'already_in_stage' })
  })

  it('no-op when the org has no matching stage', () => {
    const bare = STAGES.filter((s) => s.id === 's-new' || s.id === 's-qual')
    expect(resolveStageForEvent(bare, 'booked', 's-new')).toEqual({ skip: 'no_matching_stage' })
    expect(resolveStageForEvent(bare, 'no_show', 's-new')).toEqual({ skip: 'no_matching_stage' })
  })

  it('never targets a won/lost stage even if its name matches', () => {
    const tricky = [
      stage({ id: 's-a', name: 'New', slug: 'new', position: 0 }),
      stage({ id: 's-trap', name: 'Booked & Won', slug: 'booked-won', position: 1, is_won: true }),
    ]
    expect(resolveStageForEvent(tricky, 'booked', 's-a')).toEqual({ skip: 'no_matching_stage' })
  })

  it('null current stage still resolves a target', () => {
    const r = resolveStageForEvent(STAGES, 'booked', null)
    expect(r).toEqual({ stage: expect.objectContaining({ id: 's-booked' }) })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/stage-mover.test.ts`
Expected: FAIL — module `@/lib/pipeline/stage-mover` not found.

- [ ] **Step 3: Implement `src/lib/pipeline/stage-mover.ts`**

```ts
/**
 * Appointment-lifecycle stage automation.
 *
 * Unlike suggest-stage (which only proposes moves for human approval), this
 * HARD-moves the kanban card on concrete appointment events: booked → the
 * consult stage, canceled/no-show → the re-engage stage. Same guardrails as
 * the suggester: never touch a lead parked in a won/lost stage, never target
 * a won/lost stage, no-op when the org has no matching stage.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { PipelineStage } from '@/types/database'
import { logger } from '@/lib/logger'

export type AppointmentStageEvent = 'booked' | 'canceled' | 'no_show'

const EVENT_STAGE_PATTERNS: Record<AppointmentStageEvent, RegExp> = {
  booked: /consult|schedul|book|appoint/i,
  canceled: /no.?show|re.?engage|nurtur/i,
  no_show: /no.?show|re.?engage|nurtur/i,
}

export type StageResolution = { stage: PipelineStage } | { skip: 'won_lost_stage' | 'no_matching_stage' | 'already_in_stage' }

/** Pure stage resolution — unit-tested; the effectful mover below just executes it. */
export function resolveStageForEvent(
  stages: PipelineStage[],
  event: AppointmentStageEvent,
  currentStageId: string | null
): StageResolution {
  const current = stages.find((s) => s.id === currentStageId)
  if (current && (current.is_won || current.is_lost)) return { skip: 'won_lost_stage' }

  const re = EVENT_STAGE_PATTERNS[event]
  const target = stages.find(
    (s) => !s.is_won && !s.is_lost && (re.test(s.slug ?? '') || re.test(s.name ?? ''))
  )
  if (!target) return { skip: 'no_matching_stage' }
  if (target.id === currentStageId) return { skip: 'already_in_stage' }
  return { stage: target }
}

/**
 * Move a lead's pipeline stage for an appointment event. Non-fatal by design:
 * every failure is logged and swallowed so it can never block a booking flow.
 * Call sites invoke it fire-and-forget (`void moveLeadStageForAppointmentEvent(...)`).
 */
export async function moveLeadStageForAppointmentEvent(
  supabase: SupabaseClient,
  params: { orgId: string; leadId: string; event: AppointmentStageEvent }
): Promise<{ moved: boolean; stageId?: string; reason?: string }> {
  const { orgId, leadId, event } = params
  try {
    const [{ data: lead }, { data: stages }] = await Promise.all([
      supabase.from('leads').select('stage_id').eq('id', leadId).eq('organization_id', orgId).maybeSingle(),
      supabase.from('pipeline_stages').select('*').eq('organization_id', orgId).order('position'),
    ])
    if (!lead || !stages || stages.length === 0) return { moved: false, reason: 'lead_or_stages_missing' }

    const resolution = resolveStageForEvent(stages as PipelineStage[], event, lead.stage_id ?? null)
    if ('skip' in resolution) return { moved: false, reason: resolution.skip }

    const { error } = await supabase
      .from('leads')
      .update({ stage_id: resolution.stage.id })
      .eq('id', leadId)
      .eq('organization_id', orgId)
    if (error) return { moved: false, reason: error.message }

    await supabase.from('lead_activities').insert({
      organization_id: orgId,
      lead_id: leadId,
      activity_type: 'stage_auto_moved',
      title: `Moved to "${resolution.stage.name}" (appointment ${event.replace('_', '-')})`,
      metadata: { event, from_stage_id: lead.stage_id ?? null, to_stage_id: resolution.stage.id },
    })

    return { moved: true, stageId: resolution.stage.id }
  } catch (err) {
    logger.error('stage-mover failed', { leadId, event, error: err instanceof Error ? err.message : String(err) })
    return { moved: false, reason: 'exception' }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/stage-mover.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline/stage-mover.ts src/lib/__tests__/stage-mover.test.ts
git commit -m "feat(pipeline): stage-mover for appointment lifecycle events"
```

---

### Task 3: Wire stage-mover into every appointment path

All calls are fire-and-forget (`void ...`) placed AFTER the primary write succeeds. Deliberate exclusion: `src/lib/funnel/executor.ts` `schedule_followup` books follow-ups, not consults — no stage move there.

**Files:**
- Modify: `src/app/api/appointments/route.ts` (POST ~line 165 after the lead status update; PATCH in the cancel/no-show handling ~line 256)
- Modify: `src/app/api/booking/[orgId]/book/route.ts` (~line 242, after `syncAppointmentToEhr`)
- Modify: `src/lib/autopilot/agent-tools.ts` (~line 793, after the lead status update in the book tool)
- Modify: `src/app/api/webhooks/cal/route.ts` (BOOKING_CREATED after the lead status update ~line 147; BOOKING_CANCELLED after the appointment cancel update ~line 275)
- Modify: `src/app/api/webhooks/carestack/route.ts` (inside `handleAppointmentEvent`, after the appointment insert/update)

- [ ] **Step 1: `POST /api/appointments`** — add import `import { moveLeadStageForAppointmentEvent } from '@/lib/pipeline/stage-mover'` and, immediately after the `leads` update that sets `status: 'consultation_scheduled'`:

```ts
  // Kanban: hard-move the card to the consult stage (non-blocking).
  void moveLeadStageForAppointmentEvent(supabase, {
    orgId,
    leadId: parsed.data.lead_id,
    event: 'booked',
  })
```

- [ ] **Step 2: `PATCH /api/appointments`** — inside the existing `if (status === 'canceled' || status === 'no_show')` block (the one calling `syncAppointmentToEhr`), add:

```ts
    if (appointment.lead) {
      void moveLeadStageForAppointmentEvent(supabase, {
        orgId,
        leadId: (appointment.lead as { id: string }).id,
        event: status === 'no_show' ? 'no_show' : 'canceled',
      })
    }
```

- [ ] **Step 3: `POST /api/booking/[orgId]/book`** — after `void syncAppointmentToEhr(supabase, appointment.id, { action: 'book' })`:

```ts
  void moveLeadStageForAppointmentEvent(supabase, { orgId, leadId, event: 'booked' })
```

- [ ] **Step 4: `agent-tools.ts` book tool** — after the `leads` update that sets `status: 'consultation_scheduled'` (~line 793):

```ts
  // Kanban: hard-move the card to the consult stage (non-blocking).
  void moveLeadStageForAppointmentEvent(supabase, {
    orgId: context.organization_id,
    leadId: context.lead_id,
    event: 'booked',
  })
```

- [ ] **Step 5: Cal webhook** — in BOOKING_CREATED after the lead-status update block, add the `booked` call; in BOOKING_RESCHEDULED after the new appointment insert (~line 241), add the same `booked` call; in BOOKING_CANCELLED after the appointment update to `status: 'canceled'`, add the `canceled` call. Both use whatever lead id variable that handler already resolved (read the surrounding code — the created path has the lead row; the cancel path selects the appointment with its lead_id).

```ts
      void moveLeadStageForAppointmentEvent(supabase, { orgId: lead.organization_id, leadId: lead.id, event: 'booked' })
```

```ts
        void moveLeadStageForAppointmentEvent(supabase, { orgId: organizationId, leadId, event: 'canceled' })
```

(Adjust the org/lead variable names to the handler's actual locals; the cancel path must fetch `lead_id, organization_id` in its appointment select if it doesn't already.)

- [ ] **Step 6: CareStack webhook `handleAppointmentEvent`** — after the insert/update block and before `emitInternalEvent`, map the trigger defensively:

```ts
  // Kanban stage automation from EHR-originated appointment events.
  if (leadId) {
    const t = trigger.toLowerCase()
    const stageEvent =
      /cancel|delet/.test(t) ? ('canceled' as const)
      : /no.?show|missed/.test(t) ? ('no_show' as const)
      : /creat|schedul|book|resched|confirm/.test(t) ? ('booked' as const)
      : null
    if (stageEvent) {
      void moveLeadStageForAppointmentEvent(supabase, { orgId: organizationId, leadId, event: stageEvent })
    }
  }
```

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npx vitest run`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/appointments/route.ts "src/app/api/booking/[orgId]/book/route.ts" src/lib/autopilot/agent-tools.ts src/app/api/webhooks/cal/route.ts src/app/api/webhooks/carestack/route.ts
git commit -m "feat(pipeline): auto-move kanban stage on book/cancel/no-show across all paths"
```

---

### Task 4: Risk that survives confirmation

**Files:**
- Create: `src/lib/campaigns/attendance-risk.ts`
- Test: `src/lib/__tests__/attendance-risk.test.ts`
- Modify: `src/lib/campaigns/reminders.ts` (`calculateNoShowRisk` rewired; `confirmAppointment` stops hard-setting risk 5)
- Modify: `src/app/api/appointments/route.ts` (PATCH stops hard-setting risk 5 on confirm)

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { computeNoShowRisk, type NoShowRiskInput } from '@/lib/campaigns/attendance-risk'

const base: NoShowRiskInput = {
  confirmed: false,
  priorNoShows: 0,
  engagementScore: 50,
  remindersSent: 0,
  remindersFailed: 0,
  remindersUnanswered: 0,
  checkinExpiredUnanswered: false,
}

describe('computeNoShowRisk', () => {
  it('clean unconfirmed appointment = base 30', () => {
    expect(computeNoShowRisk(base)).toBe(30)
  })

  it('clean confirmed appointment = 5', () => {
    expect(computeNoShowRisk({ ...base, confirmed: true })).toBe(5)
  })

  it('confirmation does NOT erase history: confirmed + 2 prior no-shows = 45 (tier 1 band)', () => {
    expect(computeNoShowRisk({ ...base, confirmed: true, priorNoShows: 2 })).toBe(45)
  })

  it('prior no-shows cap at +40', () => {
    expect(computeNoShowRisk({ ...base, confirmed: true, priorNoShows: 5 })).toBe(45)
  })

  it('expired unanswered check-in adds +25 (confirmed serial no-shower hits tier 2)', () => {
    expect(
      computeNoShowRisk({ ...base, confirmed: true, priorNoShows: 2, checkinExpiredUnanswered: true })
    ).toBe(70)
  })

  it('unanswered reminders and failures raise unconfirmed risk', () => {
    expect(
      computeNoShowRisk({ ...base, remindersSent: 3, remindersUnanswered: 3, remindersFailed: 1 })
    ).toBe(65) // 30 + 20 (all unanswered) + 15 (failures)
  })

  it('low engagement adds +10', () => {
    expect(computeNoShowRisk({ ...base, engagementScore: 10 })).toBe(40)
    expect(computeNoShowRisk({ ...base, engagementScore: null })).toBe(30)
  })

  it('caps at 100', () => {
    expect(
      computeNoShowRisk({
        ...base,
        priorNoShows: 5,
        engagementScore: 0,
        remindersSent: 4,
        remindersUnanswered: 4,
        remindersFailed: 2,
        checkinExpiredUnanswered: true,
      })
    ).toBe(100)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/__tests__/attendance-risk.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/campaigns/attendance-risk.ts`**

```ts
/**
 * No-show risk math — pure and unit-tested.
 *
 * The core policy change vs. the old scorer: confirmation is a strong DOWNWARD
 * signal (base 5 instead of 30), not a terminal state. Prior no-shows, dead
 * reminders, and an ignored morning-of check-in still count, so a serial
 * no-shower who texts "C" no longer reads as zero-risk.
 */

export type NoShowRiskInput = {
  confirmed: boolean
  priorNoShows: number
  engagementScore: number | null
  remindersSent: number
  remindersFailed: number
  remindersUnanswered: number
  /** Tier-1 check-in went out and the 2h reply window elapsed with silence. */
  checkinExpiredUnanswered: boolean
}

/** Escalation thresholds — future per-practice tuning goes into booking_settings. */
export const RISK_TIER1 = 40
export const RISK_TIER2 = 70
export const CHECKIN_REPLY_WINDOW_MS = 2 * 60 * 60 * 1000

export function computeNoShowRisk(input: NoShowRiskInput): number {
  let risk = input.confirmed ? 5 : 30
  risk += Math.min(input.priorNoShows * 20, 40)
  if (input.engagementScore !== null && input.engagementScore < 20) risk += 10
  if (input.remindersFailed > 0) risk += 15
  if (input.remindersSent > 0 && input.remindersUnanswered === input.remindersSent) risk += 20
  if (input.checkinExpiredUnanswered) risk += 25
  return Math.min(risk, 100)
}

export function selectEscalationTier(risk: number): 0 | 1 | 2 {
  if (risk >= RISK_TIER2) return 2
  if (risk >= RISK_TIER1) return 1
  return 0
}

export function isCheckinExpired(
  checkinSentAt: string | null,
  checkinRepliedAt: string | null,
  now: Date
): boolean {
  if (!checkinSentAt || checkinRepliedAt) return false
  return now.getTime() - new Date(checkinSentAt).getTime() >= CHECKIN_REPLY_WINDOW_MS
}
```

Add tier/expiry tests to the same test file:

```ts
import { selectEscalationTier, isCheckinExpired, RISK_TIER1, RISK_TIER2 } from '@/lib/campaigns/attendance-risk'

describe('selectEscalationTier boundaries', () => {
  it('39 → 0, 40 → 1, 69 → 1, 70 → 2', () => {
    expect(selectEscalationTier(RISK_TIER1 - 1)).toBe(0)
    expect(selectEscalationTier(RISK_TIER1)).toBe(1)
    expect(selectEscalationTier(RISK_TIER2 - 1)).toBe(1)
    expect(selectEscalationTier(RISK_TIER2)).toBe(2)
  })
})

describe('isCheckinExpired', () => {
  const now = new Date('2026-07-02T12:00:00Z')
  it('expired only after 2h of silence', () => {
    expect(isCheckinExpired('2026-07-02T09:00:00Z', null, now)).toBe(true)
    expect(isCheckinExpired('2026-07-02T11:00:00Z', null, now)).toBe(false)
  })
  it('a reply or no check-in means never expired', () => {
    expect(isCheckinExpired('2026-07-02T09:00:00Z', '2026-07-02T09:30:00Z', now)).toBe(false)
    expect(isCheckinExpired(null, null, now)).toBe(false)
  })
})
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/__tests__/attendance-risk.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire `calculateNoShowRisk` in `src/lib/campaigns/reminders.ts`**

Replace the entire body of `calculateNoShowRisk` with a gatherer that calls the pure function (keep the export signature):

```ts
import { computeNoShowRisk, isCheckinExpired } from './attendance-risk'

export async function calculateNoShowRisk(
  supabase: SupabaseClient,
  appointmentId: string
): Promise<number> {
  const { data: apt } = await supabase
    .from('appointments')
    .select('confirmation_received, checkin_sent_at, checkin_replied_at, lead:leads(no_show_count, engagement_score)')
    .eq('id', appointmentId)
    .single()

  if (!apt) return 50

  const { data: reminders } = await supabase
    .from('appointment_reminders')
    .select('status, confirmation_status')
    .eq('appointment_id', appointmentId)

  const sent = (reminders || []).filter((r) => r.status === 'sent').length
  const failed = (reminders || []).filter((r) => r.status === 'failed').length
  const unanswered = (reminders || []).filter((r) => r.confirmation_status === 'no_response').length

  const lead = apt.lead as { no_show_count: number | null; engagement_score: number | null } | null
  const risk = computeNoShowRisk({
    confirmed: apt.confirmation_received === true,
    priorNoShows: lead?.no_show_count ?? 0,
    engagementScore: lead?.engagement_score ?? null,
    remindersSent: sent,
    remindersFailed: failed,
    remindersUnanswered: unanswered,
    checkinExpiredUnanswered: isCheckinExpired(apt.checkin_sent_at, apt.checkin_replied_at, new Date()),
  })

  await supabase.from('appointments').update({ no_show_risk_score: risk }).eq('id', appointmentId)
  return risk
}
```

- [ ] **Step 6: Kill the two hard-set-5s**

In `reminders.ts` `confirmAppointment`: remove `no_show_risk_score: 5,` from the update object, and after the update add:

```ts
  // Confirmation lowers risk but no longer erases history (serial no-showers stay visible).
  await calculateNoShowRisk(supabase, appointmentId)
```

In `src/app/api/appointments/route.ts` PATCH: remove `updateData.no_show_risk_score = 5` from the `status === 'confirmed'` branch, and after the appointment update succeeds add (import `calculateNoShowRisk` from `@/lib/campaigns/reminders`):

```ts
  if (status === 'confirmed') {
    await calculateNoShowRisk(supabase, appointment_id)
  }
```

- [ ] **Step 7: Add the 48h recompute pass to `sendAppointmentReminders`**

At the TOP of `sendAppointmentReminders` (before the 72h pass):

```ts
  // Keep day-of risk fresh: recompute for everything inside 48h each run.
  const horizon = new Date(now.getTime() + 48 * 60 * 60 * 1000)
  const { data: upcoming } = await supabase
    .from('appointments')
    .select('id')
    .eq('organization_id', orgId)
    .in('status', ['scheduled', 'confirmed'])
    .gte('scheduled_at', now.toISOString())
    .lte('scheduled_at', horizon.toISOString())
  for (const a of upcoming || []) {
    await calculateNoShowRisk(supabase, a.id)
  }
```

- [ ] **Step 8: Verify**

Run: `npx tsc --noEmit && npx vitest run`
Expected: green.

- [ ] **Step 9: Commit**

```bash
git add src/lib/campaigns/attendance-risk.ts src/lib/__tests__/attendance-risk.test.ts src/lib/campaigns/reminders.ts src/app/api/appointments/route.ts
git commit -m "feat(booking): no-show risk survives confirmation; 48h recompute pass"
```

---

### Task 5: Tiered escalation ladder

**Files:**
- Create: `src/lib/campaigns/attendance-escalation.ts`
- Modify: `src/lib/campaigns/reminders.ts` (orchestrator + 2h-call re-arm; extend `ReminderResult`)
- Modify: `src/lib/connectors/types.ts` (+ `'appointment.at_risk'` event type)
- Modify: `src/lib/connectors/slack/notify.ts` (EVENT_DISPLAY entry)
- Modify: `src/lib/connectors/google-ads/offline-conversions.ts`, `src/lib/connectors/google-ads/enhanced-conversions.ts`, `src/lib/connectors/meta/capi.ts`, `src/lib/connectors/ga4/measurement.ts` (empty-string map entries so the `Record<ConnectorEventType, ...>` maps still type-check)
- Modify: `src/app/api/webhooks/twilio/route.ts` (YES reply stamps check-in)

- [ ] **Step 1: Extend `ReminderResult` in `reminders.ts`**

```ts
export type ReminderResult = {
  appointment_id: string
  type: '72h' | '24h' | '2h' | '1h' | 'checkin_4h' | 'escalation'
  channel: 'sms' | 'email' | 'voice_confirmation' | 'slack'
  status: 'sent' | 'skipped' | 'error'
  detail?: string
}
```

- [ ] **Step 2: Add the connector event type**

`src/lib/connectors/types.ts` — add to the `ConnectorEventType` union:

```ts
  | 'appointment.at_risk'
```

`src/lib/connectors/slack/notify.ts` — add to `EVENT_DISPLAY`:

```ts
  'appointment.at_risk': { emoji: '🚨', title: 'No-Show Risk — Call This Patient', color: '#ef4444' },
```

In each of the four ad-connector event maps (`offline-conversions.ts`, `enhanced-conversions.ts`, `capi.ts`, `measurement.ts`), add the key with an empty value alongside the existing `'consultation.no_show': ''` style entries:

```ts
  'appointment.at_risk': '',
```

Run `npx tsc --noEmit` — if any of those maps is not a full `Record` and doesn't need the key, skip that file; the compiler is the referee.

- [ ] **Step 3: Implement `src/lib/campaigns/attendance-escalation.ts`**

```ts
/**
 * Tiered no-show escalation — runs as a pass inside the reminders cron.
 *
 * Tier 1 (risk 40–69), ~4h before the visit: AI check-in SMS that requires a
 * reply. Silence for 2h re-arms the 2h AI confirmation call (see the .or()
 * clause in send2hConfirmationCalls) even if the patient "confirmed" days ago.
 *
 * Tier 2 (risk ≥70), day-of: one staff escalation — lead_activities row
 * (drives the At-Risk queue on /appointments) + Slack alert via the connector
 * dispatcher. Fires at most once per appointment.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { dispatchConnectorEvent } from '@/lib/connectors/dispatcher'
import { RISK_TIER1, RISK_TIER2 } from './attendance-risk'
import type { ReminderResult } from './reminders'
import { logger } from '@/lib/logger'

type EscalationAppointment = {
  id: string
  lead_id: string
  scheduled_at: string
  no_show_risk_score: number
  checkin_sent_at: string | null
  escalated_at: string | null
  lead: {
    id: string
    first_name: string | null
    last_name: string | null
    phone: string | null
    email: string | null
    source_type: string | null
    no_show_count: number | null
    sms_consent: boolean
    sms_opt_out: boolean
  } | null
}

const APPT_SELECT =
  'id, lead_id, scheduled_at, no_show_risk_score, checkin_sent_at, escalated_at, ' +
  'lead:leads(id, first_name, last_name, phone, email, source_type, no_show_count, sms_consent, sms_opt_out)'

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

export async function runAttendanceEscalation(
  supabase: SupabaseClient,
  orgId: string,
  practiceName: string,
  now: Date
): Promise<ReminderResult[]> {
  const results: ReminderResult[] = []

  // ── Tier 1: morning-of check-in, window 3.5–4.5h before the visit ──
  const t1From = new Date(now.getTime() + 3.5 * 60 * 60 * 1000)
  const t1To = new Date(now.getTime() + 4.5 * 60 * 60 * 1000)

  const { data: tier1 } = await supabase
    .from('appointments')
    .select(APPT_SELECT)
    .eq('organization_id', orgId)
    .in('status', ['scheduled', 'confirmed'])
    .is('checkin_sent_at', null)
    .gte('no_show_risk_score', RISK_TIER1)
    .lt('no_show_risk_score', RISK_TIER2)
    .gte('scheduled_at', t1From.toISOString())
    .lte('scheduled_at', t1To.toISOString())

  for (const apt of (tier1 || []) as unknown as EscalationAppointment[]) {
    const lead = apt.lead
    if (!lead?.phone || lead.sms_opt_out) {
      results.push({ appointment_id: apt.id, type: 'checkin_4h', channel: 'sms', status: 'skipped', detail: 'no_phone_or_opted_out' })
      continue
    }
    const body = `Hi ${lead.first_name || 'there'}, quick check-in from ${practiceName} — will we see you at ${formatTime(apt.scheduled_at)} today? Reply YES to confirm, or reply here if you need to reschedule.`
    try {
      const sendRes = await sendSMSToLead({ supabase, leadId: lead.id, to: lead.phone, body, caller: 'escalation.checkin_4h' })
      if (!sendRes.sent) {
        results.push({ appointment_id: apt.id, type: 'checkin_4h', channel: 'sms', status: 'skipped', detail: `consent:${sendRes.reason}` })
        continue
      }
      await supabase.from('appointment_reminders').insert({
        organization_id: orgId,
        appointment_id: apt.id,
        lead_id: lead.id,
        channel: 'sms',
        reminder_type: 'checkin_4h',
        status: 'sent',
        sent_at: new Date().toISOString(),
        external_id: sendRes.sid,
      })
      await supabase
        .from('appointments')
        .update({ checkin_sent_at: new Date().toISOString(), escalation_tier: 1 })
        .eq('id', apt.id)
      results.push({ appointment_id: apt.id, type: 'checkin_4h', channel: 'sms', status: 'sent' })
    } catch (err) {
      results.push({ appointment_id: apt.id, type: 'checkin_4h', channel: 'sms', status: 'error', detail: err instanceof Error ? err.message : 'unknown' })
    }
  }

  // ── Tier 2: staff escalation, day-of (within 8h), once per appointment ──
  const t2To = new Date(now.getTime() + 8 * 60 * 60 * 1000)

  const { data: tier2 } = await supabase
    .from('appointments')
    .select(APPT_SELECT)
    .eq('organization_id', orgId)
    .in('status', ['scheduled', 'confirmed'])
    .is('escalated_at', null)
    .gte('no_show_risk_score', RISK_TIER2)
    .gte('scheduled_at', now.toISOString())
    .lte('scheduled_at', t2To.toISOString())

  for (const apt of (tier2 || []) as unknown as EscalationAppointment[]) {
    const lead = apt.lead
    if (!lead) continue
    try {
      await supabase.from('lead_activities').insert({
        organization_id: orgId,
        lead_id: lead.id,
        activity_type: 'attendance_escalated',
        title: `High no-show risk (${apt.no_show_risk_score}) — personal call recommended before ${formatTime(apt.scheduled_at)}`,
        metadata: {
          appointment_id: apt.id,
          risk: apt.no_show_risk_score,
          prior_no_shows: lead.no_show_count ?? 0,
        },
      })

      // Slack only — ad connectors are filtered out before any network call.
      await dispatchConnectorEvent(
        supabase,
        {
          type: 'appointment.at_risk',
          organizationId: orgId,
          leadId: lead.id,
          timestamp: new Date().toISOString(),
          data: {
            lead: {
              id: lead.id,
              firstName: lead.first_name || 'Unknown',
              lastName: lead.last_name || '',
              phone: lead.phone,
              email: lead.email,
              source_type: lead.source_type,
            },
            metadata: {
              appointment_time: formatTime(apt.scheduled_at),
              risk_score: apt.no_show_risk_score,
              prior_no_shows: lead.no_show_count ?? 0,
            },
          },
        },
        { only: ['slack'] }
      )

      await supabase
        .from('appointments')
        .update({ escalated_at: new Date().toISOString(), escalation_tier: 2 })
        .eq('id', apt.id)

      results.push({ appointment_id: apt.id, type: 'escalation', channel: 'slack', status: 'sent' })
    } catch (err) {
      logger.error('tier-2 escalation failed', { appointment_id: apt.id, error: err instanceof Error ? err.message : String(err) })
      results.push({ appointment_id: apt.id, type: 'escalation', channel: 'slack', status: 'error', detail: err instanceof Error ? err.message : 'unknown' })
    }
  }

  return results
}
```

(Verify the `ConnectorLeadData` optional fields against `src/lib/connectors/types.ts` — pass only fields the type declares.)

- [ ] **Step 4: Wire into the orchestrator**

In `sendAppointmentReminders` (after the risk-recompute pass from Task 4, before the 72h pass):

```ts
  // ─── ESCALATION LADDER (risk-based, day-of) ────────────────
  const esc = await runAttendanceEscalation(supabase, orgId, practiceName, now)
  results.push(...esc)
```

Import: `import { runAttendanceEscalation } from './attendance-escalation'`.

- [ ] **Step 5: Re-arm the 2h AI call when a check-in expires unanswered**

In `send2hConfirmationCalls`, replace the query filters:

```ts
    .in('status', ['scheduled']) // Only call unconfirmed appointments
    .eq('reminder_sent_2h', false)
    .eq('confirmation_call_made', false)
    .eq('confirmation_received', false) // Skip already confirmed
```

with:

```ts
    .in('status', ['scheduled', 'confirmed'])
    .eq('reminder_sent_2h', false)
    .eq('confirmation_call_made', false)
    // Unconfirmed appointments — OR confirmed ones whose morning-of check-in
    // expired unanswered (2h of silence makes the old confirmation stale).
    .or(
      `confirmation_received.eq.false,and(checkin_sent_at.lt.${new Date(now.getTime() - CHECKIN_REPLY_WINDOW_MS).toISOString()},checkin_replied_at.is.null)`
    )
```

Import `CHECKIN_REPLY_WINDOW_MS` from `./attendance-risk`.

- [ ] **Step 6: Stamp check-in replies in the Twilio webhook**

In `src/app/api/webhooks/twilio/route.ts`, inside the existing `confirmKeywords.test(body)` branch, BEFORE the existing unconfirmed-appointment lookup, add:

```ts
    // Tier-1 check-in reply: stamp the pending check-in and refresh risk.
    const { data: checkinApt } = await supabase
      .from('appointments')
      .select('id')
      .eq('lead_id', lead.id)
      .not('checkin_sent_at', 'is', null)
      .is('checkin_replied_at', null)
      .gte('scheduled_at', new Date().toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (checkinApt) {
      await supabase
        .from('appointments')
        .update({ checkin_replied_at: new Date().toISOString() })
        .eq('id', checkinApt.id)
      const { calculateNoShowRisk } = await import('@/lib/campaigns/reminders')
      await calculateNoShowRisk(supabase, checkinApt.id)
    }
```

Do NOT return early here — fall through so the existing unconfirmed-appointment confirmation still runs (a YES can legitimately do both).

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npx vitest run`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add src/lib/campaigns/attendance-escalation.ts src/lib/campaigns/reminders.ts src/lib/connectors/types.ts src/lib/connectors/slack/notify.ts src/lib/connectors/google-ads/offline-conversions.ts src/lib/connectors/google-ads/enhanced-conversions.ts src/lib/connectors/meta/capi.ts src/lib/connectors/ga4/measurement.ts src/app/api/webhooks/twilio/route.ts
git commit -m "feat(booking): tiered no-show escalation — AI check-in, staff+Slack, 2h call re-arm"
```

---

### Task 6: No-show recovery nurture

**Files:**
- Create: `src/lib/campaigns/no-show-recovery.ts`
- Test: `src/lib/__tests__/no-show-recovery.test.ts`
- Modify: `src/app/api/appointments/route.ts` (PATCH no-show branch fires the trigger)

- [ ] **Step 1: Write the failing test** (pure parts: step seeds + exit statuses)

```ts
import { describe, it, expect } from 'vitest'
import {
  NO_SHOW_RECOVERY_STEPS,
  NO_SHOW_RECOVERY_EXIT_STATUSES,
} from '@/lib/campaigns/no-show-recovery'

describe('no-show recovery campaign shape', () => {
  it('is a 3-touch sequence: same-day SMS, day-3 SMS, day-10 email', () => {
    expect(NO_SHOW_RECOVERY_STEPS.map((s) => [s.step_number, s.channel, s.delay_minutes])).toEqual([
      [1, 'sms', 30],
      [2, 'sms', 3 * 1440 - 30],
      [3, 'email', 7 * 1440],
    ])
  })

  it('rebooking exits the campaign (consultation_scheduled is an exit status)', () => {
    expect(NO_SHOW_RECOVERY_EXIT_STATUSES).toContain('consultation_scheduled')
    expect(NO_SHOW_RECOVERY_EXIT_STATUSES).toContain('lost')
  })

  it('every step has fallback copy referencing the practice', () => {
    for (const s of NO_SHOW_RECOVERY_STEPS) {
      expect(s.body_template).toContain('{{first_name}}')
      expect(s.body_template.length).toBeGreaterThan(40)
    }
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/__tests__/no-show-recovery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/campaigns/no-show-recovery.ts`** (mirrors `post-consult-nurture.ts` exactly — same seeding idiom, same dual-shaped exit condition)

```ts
/**
 * No-Show Recovery — 3-touch rebooking sequence.
 *
 * Enrolls on the `appointment_no_show` trigger (fired when staff or the EHR
 * marks a no-show). A reply or a new booking (status → consultation_scheduled)
 * exits the sequence. Seeded lazily per org like the post-consult nurture so
 * there's no migration-managed campaign SQL to drift.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { NurtureStepSeed } from './post-consult-nurture'

export const NO_SHOW_RECOVERY_KEY = 'no_show_recovery'
export const NO_SHOW_RECOVERY_VERSION = 1

/** Rebooked, converting, or dead — stop chasing. */
export const NO_SHOW_RECOVERY_EXIT_STATUSES = [
  'consultation_scheduled',
  'consultation_completed',
  'contract_sent',
  'contract_signed',
  'scheduled',
  'in_treatment',
  'completed',
  'lost',
  'disqualified',
] as const

const EXIT_CONDITION = {
  type: 'if_replied',
  if_replied: true,
  if_status_in: [...NO_SHOW_RECOVERY_EXIT_STATUSES],
} as const

const DAY = 1440 // minutes

export const NO_SHOW_RECOVERY_STEPS: NurtureStepSeed[] = [
  {
    step_number: 1,
    name: 'Same-day — we missed you',
    channel: 'sms',
    delay_minutes: 30,
    ai_personalize: false,
    body_template:
      "Hi {{first_name}}, we missed you at {{practice_name}} today! Life happens — want to grab another time? Reply here and we'll get you rescheduled in seconds.",
    metadata: {},
  },
  {
    step_number: 2,
    name: 'Day 3 — remove the blocker',
    channel: 'sms',
    delay_minutes: 3 * DAY - 30,
    ai_personalize: true,
    body_template:
      "Hi {{first_name}}, just checking in — sometimes the timing isn't right, and sometimes there's a question holding things up. Either way I'd love to help. What would make it easier to come in?",
    metadata: {
      ai_generator: 'closer',
      nurture_goal:
        'Warmly re-open after a missed consultation. Acknowledge that missing an appointment is normal, gently surface whatever blocked them (schedule, nerves, cost), and invite a reschedule. No guilt, no pressure, one question.',
    },
  },
  {
    step_number: 3,
    name: 'Day 10 — open door',
    channel: 'email',
    delay_minutes: 7 * DAY,
    ai_personalize: true,
    subject: 'Your consultation spot is still here, {{first_name}}',
    body_template:
      "Hi {{first_name}}, we'd still love to see you. Whenever the timing works, reply to this email or give us a call and we'll find a time that fits your schedule.",
    metadata: {
      ai_generator: 'closer',
      nurture_goal:
        'Final soft invitation to rebook after a no-show. Low pressure, keep the door open, remind them why they reached out in the first place if their profile shows a motivation.',
    },
  },
]

const SEND_WINDOW = { start_hour: 9, end_hour: 19, timezone: 'America/New_York', days: [1, 2, 3, 4, 5, 6] }

export async function getNoShowRecoveryCampaignId(
  supabase: SupabaseClient,
  organizationId: string
): Promise<string | null> {
  const { data } = await supabase
    .from('campaigns')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('type', 'trigger')
    .eq('metadata->>system_key', NO_SHOW_RECOVERY_KEY)
    .limit(1)
    .maybeSingle<{ id: string }>()
  return data?.id ?? null
}

/** Idempotent per-org seeding — same rollback-on-partial-failure idiom as seedPostConsultNurture. */
export async function seedNoShowRecovery(
  supabase: SupabaseClient,
  organizationId: string
): Promise<string | null> {
  const existing = await getNoShowRecoveryCampaignId(supabase, organizationId)
  if (existing) return existing

  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .insert({
      organization_id: organizationId,
      name: 'No-Show Recovery',
      description:
        'Rebooking sequence for patients who no-showed a consultation: same-day "we missed you" SMS, a day-3 objection-aware check-in, and a day-10 open-door email. Auto-enrolls on the appointment_no_show trigger; exits on reply or rebooking.',
      type: 'trigger',
      channel: 'multi',
      status: 'active',
      target_criteria: { trigger_event: 'appointment_no_show', has_phone: true },
      send_window: SEND_WINDOW,
      metadata: { system_key: NO_SHOW_RECOVERY_KEY, version: NO_SHOW_RECOVERY_VERSION },
    })
    .select('id')
    .single<{ id: string }>()

  if (campaignError || !campaign) {
    return await getNoShowRecoveryCampaignId(supabase, organizationId)
  }

  const stepRows = NO_SHOW_RECOVERY_STEPS.map((s) => ({
    campaign_id: campaign.id,
    organization_id: organizationId,
    step_number: s.step_number,
    name: s.name,
    channel: s.channel,
    delay_minutes: s.delay_minutes,
    delay_type: 'after_previous',
    subject: s.subject ?? null,
    body_template: s.body_template,
    ai_personalize: s.ai_personalize,
    send_condition: s.send_condition ?? null,
    exit_condition: EXIT_CONDITION,
    metadata: s.metadata,
  }))

  const { error: stepsError } = await supabase.from('campaign_steps').insert(stepRows)
  if (stepsError) {
    await supabase.from('campaigns').delete().eq('id', campaign.id)
    return null
  }

  return campaign.id
}
```

(`NurtureStepSeed` is already exported from `post-consult-nurture.ts` — reuse it, don't redefine.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/__tests__/no-show-recovery.test.ts`
Expected: PASS.

- [ ] **Step 5: Fire the trigger from the PATCH no-show branch**

In `src/app/api/appointments/route.ts`, inside the existing `if (status === 'no_show' && appointment.lead)` block (right after the `no_show_count` increment), add (imports: `seedNoShowRecovery` from `@/lib/campaigns/no-show-recovery`; `processTriggerCampaigns` is already imported):

```ts
    // Recovery: seed the org's rebook sequence (idempotent) and enroll this lead.
    // Non-fatal — a failure here never blocks the status update.
    try {
      await seedNoShowRecovery(supabase, orgId)
      await processTriggerCampaigns(supabase, {
        event: 'appointment_no_show',
        lead_id: lead.id,
        organization_id: orgId,
      })
    } catch (err) {
      console.error('[appointments] no-show recovery enrollment failed:', err instanceof Error ? err.message : err)
    }
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npx vitest run`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/lib/campaigns/no-show-recovery.ts src/lib/__tests__/no-show-recovery.test.ts src/app/api/appointments/route.ts
git commit -m "feat(campaigns): no-show recovery rebook nurture on appointment_no_show trigger"
```

---

### Task 7: Dashboard surfacing

**Files:**
- Modify: `src/app/(dashboard)/appointments/page.tsx`

The page already has an `at_risk` filter and count — align its threshold with the ladder and show escalation state.

- [ ] **Step 1: Align thresholds**

Import at top: `import { RISK_TIER1, RISK_TIER2 } from '@/lib/campaigns/attendance-risk'`.

Replace both occurrences of `a.no_show_risk_score >= 50` (the `atRiskCount` calc ~line 172 and the `at_risk` filter ~line 189) with `a.no_show_risk_score >= RISK_TIER1`.

- [ ] **Step 2: Add escalation fields to the page's `AppointmentData` type**

```ts
  escalation_tier: number | null
  checkin_sent_at: string | null
  checkin_replied_at: string | null
```

- [ ] **Step 3: Show escalation state on the appointment row**

Find where the row/card renders the risk score (grep `no_show_risk_score` below line 300 in the file; the card component receives the appointment). Next to the risk display, add:

```tsx
{apt.escalation_tier === 2 && (
  <Badge variant="destructive" className="text-xs">Escalated — call now</Badge>
)}
{apt.escalation_tier === 1 && !apt.checkin_replied_at && (
  <Badge variant="outline" className="text-xs">Check-in sent</Badge>
)}
{apt.escalation_tier === 1 && apt.checkin_replied_at && (
  <Badge variant="secondary" className="text-xs">Check-in ✓</Badge>
)}
```

(If the row renders in a child component, thread the three fields through its props with the same JSX; keep `RISK_TIER2` import only if used.)

- [ ] **Step 4: Verify + commit**

Run: `npx tsc --noEmit && npx vitest run`
Expected: green.

```bash
git add "src/app/(dashboard)/appointments/page.tsx"
git commit -m "feat(appointments): surface escalation state; align at-risk threshold with ladder"
```

---

### Task 8: Full verification + finish

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: all tests pass (487+ existing + ~20 new).

- [ ] **Step 2: Type check + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean (type errors block Vercel on main).

- [ ] **Step 3: Grep for regressions**

Run: `grep -rn "no_show_risk_score: 5\b" src/ --include="*.ts"`
Expected: no matches (both hard-sets removed).

- [ ] **Step 4: Finish the branch**

Use superpowers:finishing-a-development-branch — push, open a PR against `main` titled "feat: no-show prevention — stage automation, risk-survives-confirmation, tiered escalation, recovery nurture". PR body must flag: **migration `20260702100000_attendance_escalation.sql` must be applied to prod via `supabase db query --linked -f <file>` before/at deploy** (never `supabase db push`).

---

## Self-review notes (already applied)

- Spec §5 "At-risk today filter" — mostly pre-existing; Task 7 aligns thresholds instead of rebuilding.
- Spec's "staff task in the attendance-confirm queue" — that queue is not on `main`; the staff-facing queue IS the appointments page at-risk filter + `lead_activities` row (`attendance_escalated`) + Slack. Spec intent preserved.
- Trigger event name: spec said "new `no_show` event"; the union already contains `appointment_no_show` (unused) — reused instead of adding a duplicate.
- CareStack no-show recovery enrollment: the webhook path only fires stage moves (Task 3); recovery enrollment fires from the staff PATCH path. If CareStack no-show triggers are later confirmed to arrive, add the same seed+trigger block to `handleAppointmentEvent`.
