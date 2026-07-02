# Post-Consult Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a post-appointment loop — staff confirm who showed up, record a structured consult outcome, and (opt-in) automatically request patient feedback that routes promoters to a public Google review and detractors to private service recovery.

**Architecture:** Extend `appointments` with attendance/outcome columns and add a `patient_feedback` table. Pure, unit-tested helpers hold all the logic (attendance predicate, feedback-due predicate, outcome→lead-status mapping, review-gating). Thin glue wires them into: a new outcome API route, the existing Appointments page, the in-app realtime bell, a new `/api/cron/appointment-outcomes` cron (attendance sweep + feedback dispatch), and a public `/feedback/[token]` page. Behaviour is internal-only by default; patient feedback is opt-in per practice via `booking_settings`.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (PostgreSQL + RLS), Zod, Twilio (`sendSMSToLead`), Resend (`sendEmailToLead`), Vercel Cron, shadcn/ui, the existing test suite in `src/lib/__tests__/` (same `describe/it/expect` style as `no-show-fee.test.ts`).

**Spec:** `docs/superpowers/specs/2026-07-01-post-consult-flow-design.md`

**Before you start:** Work in an isolated branch/worktree off `feat/phone-first-booking` (shared-checkout hazard — see spec §8). Run `npm run test -- <file>` for a single file and `npx tsc --noEmit` before every commit (tsc errors fail the Vercel build).

---

## File Structure

**Create:**
- `supabase/migrations/20260701_post_consult_flow.sql` — new columns + `patient_feedback` table + RLS + indexes
- `src/lib/appointments/outcome.ts` — `ConsultOutcome`/`ConsultOutcomeReason` types + `outcomeToLeadStatus()`
- `src/lib/appointments/post-consult.ts` — `shouldPromptOutcome()`, `isFeedbackDue()` predicates + `sweepAttendance()` + `dispatchFeedbackRequests()`
- `src/lib/feedback/review-gating.ts` — `classifyFeedback()` + `generateFeedbackToken()`
- `src/lib/__tests__/post-consult.test.ts`, `src/lib/__tests__/review-gating.test.ts`, `src/lib/__tests__/outcome-mapping.test.ts`
- `src/app/api/appointments/[id]/outcome/route.ts` — record outcome
- `src/app/api/cron/appointment-outcomes/route.ts` — cron
- `src/app/api/feedback/[token]/route.ts` — public feedback submit
- `src/app/feedback/[token]/page.tsx` — public feedback page
- `src/components/crm/consult-outcome-dialog.tsx` — outcome capture dialog

**Modify:**
- `src/types/database.ts` — `Appointment`, `BookingSettings`, new `PatientFeedback`, outcome unions
- `src/app/api/appointments/route.ts` — clear `outcome_review_pending` on terminal PATCH transitions
- `src/app/(dashboard)/appointments/page.tsx` — "Needs Outcome" tab, `!isPast` fix, wire dialog
- `src/lib/hooks/use-realtime-notifications.ts` — appointments UPDATE listener
- `src/app/api/settings/booking-protocol/route.ts` — extend `PROTOCOL_COLUMNS` + `patchSchema`
- `src/components/settings/booking-protocol-settings.tsx` — feedback settings section
- `vercel.json` — cron entry

---

## Task 1: Database migration + types

**Files:**
- Create: `supabase/migrations/20260701_post_consult_flow.sql`
- Modify: `src/types/database.ts`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260701_post_consult_flow.sql`:

```sql
-- ═══════════════════════════════════════════════════════════════
-- Post-Consult Flow: attendance review, structured outcome, feedback
-- Builds on 20260701_phone_first_protocol.sql. Internal features are
-- always on; patient feedback is opt-in per practice (default OFF).
-- ═══════════════════════════════════════════════════════════════

-- 1. appointments: attendance-review + structured outcome
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS outcome_review_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS outcome_prompt_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS consult_outcome text
    CHECK (consult_outcome IS NULL OR consult_outcome IN
      ('treatment_accepted','deposit_paid','considering','declined','referred_out','no_decision')),
  ADD COLUMN IF NOT EXISTS consult_outcome_reason text
    CHECK (consult_outcome_reason IS NULL OR consult_outcome_reason IN
      ('price','financing','timing','second_opinion','medical','spouse_partner','other')),
  ADD COLUMN IF NOT EXISTS quoted_value_cents integer
    CHECK (quoted_value_cents IS NULL OR quoted_value_cents >= 0),
  ADD COLUMN IF NOT EXISTS outcome_notes text,
  ADD COLUMN IF NOT EXISTS outcome_follow_up_at timestamptz,
  ADD COLUMN IF NOT EXISTS outcome_recorded_at timestamptz,
  ADD COLUMN IF NOT EXISTS outcome_recorded_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_appointments_outcome_review_pending
  ON appointments (organization_id, outcome_review_pending)
  WHERE outcome_review_pending = true;

CREATE INDEX IF NOT EXISTS idx_appointments_outcome_recorded
  ON appointments (organization_id, outcome_recorded_at)
  WHERE outcome_recorded_at IS NOT NULL;

-- 2. booking_settings: feedback config (opt-in)
ALTER TABLE booking_settings
  ADD COLUMN IF NOT EXISTS feedback_request_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS google_review_url text,
  ADD COLUMN IF NOT EXISTS feedback_promoter_threshold smallint NOT NULL DEFAULT 4
    CHECK (feedback_promoter_threshold BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS feedback_delay_hours integer NOT NULL DEFAULT 2
    CHECK (feedback_delay_hours BETWEEN 0 AND 168);

-- 3. patient_feedback table
CREATE TABLE IF NOT EXISTS patient_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  token text NOT NULL UNIQUE,
  channel text NOT NULL CHECK (channel IN ('sms','email')),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','responded','opted_out','bounced')),
  rating smallint CHECK (rating BETWEEN 1 AND 5),
  comment text,
  sentiment text CHECK (sentiment IS NULL OR sentiment IN ('positive','neutral','negative')),
  routed_to_review boolean NOT NULL DEFAULT false,
  requested_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_feedback_appointment
  ON patient_feedback (appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_patient_feedback_org_status
  ON patient_feedback (organization_id, status);

-- 4. RLS: org-scoped reads/writes (public submit uses the service client + token)
ALTER TABLE patient_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY patient_feedback_org_select ON patient_feedback
  FOR SELECT USING (organization_id = get_user_org_id());
CREATE POLICY patient_feedback_org_all ON patient_feedback
  FOR ALL USING (organization_id = get_user_org_id())
  WITH CHECK (organization_id = get_user_org_id());
```

- [ ] **Step 2: Add types to `src/types/database.ts`**

Add the union types near the other unions (after `LeadStatus`):

```ts
export type ConsultOutcome =
  | 'treatment_accepted' | 'deposit_paid' | 'considering'
  | 'declined' | 'referred_out' | 'no_decision'
export type ConsultOutcomeReason =
  | 'price' | 'financing' | 'timing' | 'second_opinion'
  | 'medical' | 'spouse_partner' | 'other'
export type PatientFeedbackStatus = 'requested' | 'responded' | 'opted_out' | 'bounced'
export type FeedbackSentiment = 'positive' | 'neutral' | 'negative'

export type PatientFeedback = {
  id: string
  organization_id: string
  lead_id: string
  appointment_id: string | null
  token: string
  channel: 'sms' | 'email'
  status: PatientFeedbackStatus
  rating: number | null
  comment: string | null
  sentiment: FeedbackSentiment | null
  routed_to_review: boolean
  requested_at: string
  responded_at: string | null
  created_at: string
}
```

Add to the existing `Appointment` type (append the fields):

```ts
  outcome_review_pending?: boolean
  outcome_prompt_sent_at?: string | null
  consult_outcome?: ConsultOutcome | null
  consult_outcome_reason?: ConsultOutcomeReason | null
  quoted_value_cents?: number | null
  outcome_notes?: string | null
  outcome_follow_up_at?: string | null
  outcome_recorded_at?: string | null
  outcome_recorded_by?: string | null
```

Add to the existing `BookingSettings` type (find `export type BookingSettings`; if none exists, add the fields wherever booking_settings is typed):

```ts
  feedback_request_enabled?: boolean
  google_review_url?: string | null
  feedback_promoter_threshold?: number
  feedback_delay_hours?: number
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260701_post_consult_flow.sql src/types/database.ts
git commit -m "feat(post-consult): migration + types for attendance, outcome, feedback"
```

---

## Task 2: Pure helpers (mapping, predicates, review-gating) — TDD

These four functions hold all the decision logic and are pure (no I/O), so they are tested directly.

**Files:**
- Create: `src/lib/appointments/outcome.ts`, `src/lib/appointments/post-consult.ts`, `src/lib/feedback/review-gating.ts`
- Test: `src/lib/__tests__/outcome-mapping.test.ts`, `src/lib/__tests__/post-consult.test.ts`, `src/lib/__tests__/review-gating.test.ts`

- [ ] **Step 1: Write failing tests for the outcome→status mapping**

Create `src/lib/__tests__/outcome-mapping.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { outcomeToLeadStatus } from '@/lib/appointments/outcome'

describe('outcomeToLeadStatus', () => {
  it('maps acceptance to treatment_presented', () => {
    expect(outcomeToLeadStatus('treatment_accepted')).toBe('treatment_presented')
  })
  it('maps deposit_paid to financing', () => {
    expect(outcomeToLeadStatus('deposit_paid')).toBe('financing')
  })
  it('maps considering and no_decision to consultation_completed', () => {
    expect(outcomeToLeadStatus('considering')).toBe('consultation_completed')
    expect(outcomeToLeadStatus('no_decision')).toBe('consultation_completed')
  })
  it('maps declined to lost and referred_out to disqualified', () => {
    expect(outcomeToLeadStatus('declined')).toBe('lost')
    expect(outcomeToLeadStatus('referred_out')).toBe('disqualified')
  })
})
```

> If the suite uses jest not vitest, change the import to remove the `vitest` line (jest provides globals). Match `src/lib/__tests__/no-show-fee.test.ts`.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- outcome-mapping`
Expected: FAIL ("Cannot find module '@/lib/appointments/outcome'").

- [ ] **Step 3: Implement `src/lib/appointments/outcome.ts`**

```ts
import type { ConsultOutcome, LeadStatus } from '@/types/database'

export type { ConsultOutcome, ConsultOutcomeReason } from '@/types/database'

/** Map a recorded consult outcome to the lead's pipeline status. */
export function outcomeToLeadStatus(outcome: ConsultOutcome): LeadStatus {
  switch (outcome) {
    case 'treatment_accepted': return 'treatment_presented'
    case 'deposit_paid':       return 'financing'
    case 'considering':        return 'consultation_completed'
    case 'no_decision':        return 'consultation_completed'
    case 'declined':           return 'lost'
    case 'referred_out':       return 'disqualified'
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -- outcome-mapping`
Expected: PASS.

- [ ] **Step 5: Write failing tests for the predicates**

Create `src/lib/__tests__/post-consult.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { shouldPromptOutcome, isFeedbackDue } from '@/lib/appointments/post-consult'

const NOW = new Date('2026-07-01T18:00:00Z')

describe('shouldPromptOutcome', () => {
  const base = { status: 'confirmed', duration_minutes: 60, outcome_prompt_sent_at: null }
  it('true when the appointment has ended and is undecided/unprompted', () => {
    expect(shouldPromptOutcome({ ...base, scheduled_at: '2026-07-01T16:00:00Z' }, NOW)).toBe(true)
  })
  it('false when the appointment has not yet ended', () => {
    expect(shouldPromptOutcome({ ...base, scheduled_at: '2026-07-01T17:30:00Z' }, NOW)).toBe(false)
  })
  it('false when already prompted', () => {
    expect(shouldPromptOutcome({ ...base, scheduled_at: '2026-07-01T16:00:00Z', outcome_prompt_sent_at: '2026-07-01T17:05:00Z' }, NOW)).toBe(false)
  })
  it('false for terminal statuses', () => {
    expect(shouldPromptOutcome({ ...base, status: 'completed', scheduled_at: '2026-07-01T16:00:00Z' }, NOW)).toBe(false)
    expect(shouldPromptOutcome({ ...base, status: 'no_show', scheduled_at: '2026-07-01T16:00:00Z' }, NOW)).toBe(false)
  })
})

describe('isFeedbackDue', () => {
  it('true when completed + outcome recorded + past the delay window', () => {
    expect(isFeedbackDue({ status: 'completed', outcome_recorded_at: '2026-07-01T15:00:00Z' }, NOW, 2)).toBe(true)
  })
  it('false before the delay window elapses', () => {
    expect(isFeedbackDue({ status: 'completed', outcome_recorded_at: '2026-07-01T17:00:00Z' }, NOW, 2)).toBe(false)
  })
  it('false when no outcome was recorded', () => {
    expect(isFeedbackDue({ status: 'completed', outcome_recorded_at: null }, NOW, 2)).toBe(false)
  })
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `npm run test -- post-consult`
Expected: FAIL (module not found).

- [ ] **Step 7: Implement the predicates in `src/lib/appointments/post-consult.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js'

type AttendanceCandidate = {
  status: string
  scheduled_at: string
  duration_minutes: number | null
  outcome_prompt_sent_at: string | null
}

/** An appointment whose time has passed but has no terminal decision yet. */
export function shouldPromptOutcome(appt: AttendanceCandidate, now: Date): boolean {
  if (appt.status !== 'scheduled' && appt.status !== 'confirmed') return false
  if (appt.outcome_prompt_sent_at) return false
  const end = new Date(appt.scheduled_at).getTime() + (appt.duration_minutes ?? 60) * 60_000
  return end < now.getTime()
}

type FeedbackCandidate = { status: string; outcome_recorded_at: string | null }

/** A showed + outcome-recorded appointment past its feedback delay window. */
export function isFeedbackDue(appt: FeedbackCandidate, now: Date, delayHours: number): boolean {
  if (appt.status !== 'completed' || !appt.outcome_recorded_at) return false
  const due = new Date(appt.outcome_recorded_at).getTime() + delayHours * 3_600_000
  return now.getTime() >= due
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `npm run test -- post-consult`
Expected: PASS.

- [ ] **Step 9: Write failing tests for review-gating**

Create `src/lib/__tests__/review-gating.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { classifyFeedback, generateFeedbackToken } from '@/lib/feedback/review-gating'

describe('classifyFeedback', () => {
  it('routes ratings at/above the threshold to the public review', () => {
    expect(classifyFeedback(5, 4)).toEqual({ sentiment: 'positive', routedToReview: true })
    expect(classifyFeedback(4, 4)).toEqual({ sentiment: 'positive', routedToReview: true })
  })
  it('keeps ratings below the threshold private', () => {
    expect(classifyFeedback(3, 4)).toEqual({ sentiment: 'neutral', routedToReview: false })
    expect(classifyFeedback(2, 4)).toEqual({ sentiment: 'negative', routedToReview: false })
    expect(classifyFeedback(1, 4)).toEqual({ sentiment: 'negative', routedToReview: false })
  })
})

describe('generateFeedbackToken', () => {
  it('produces distinct, URL-safe tokens', () => {
    const a = generateFeedbackToken(), b = generateFeedbackToken()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a.length).toBeGreaterThanOrEqual(16)
  })
})
```

- [ ] **Step 10: Run to verify it fails**

Run: `npm run test -- review-gating`
Expected: FAIL (module not found).

- [ ] **Step 11: Implement `src/lib/feedback/review-gating.ts`**

```ts
import type { FeedbackSentiment } from '@/types/database'

export function classifyFeedback(
  rating: number,
  promoterThreshold: number
): { sentiment: FeedbackSentiment; routedToReview: boolean } {
  const sentiment: FeedbackSentiment = rating >= 4 ? 'positive' : rating === 3 ? 'neutral' : 'negative'
  return { sentiment, routedToReview: rating >= promoterThreshold }
}

/** Unguessable public token for the /feedback/[token] page. */
export function generateFeedbackToken(): string {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  // base64url without padding
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
```

- [ ] **Step 12: Run to verify it passes, then typecheck**

Run: `npm run test -- review-gating` → PASS
Run: `npx tsc --noEmit` → PASS

- [ ] **Step 13: Commit**

```bash
git add src/lib/appointments/outcome.ts src/lib/appointments/post-consult.ts src/lib/feedback/review-gating.ts src/lib/__tests__/outcome-mapping.test.ts src/lib/__tests__/post-consult.test.ts src/lib/__tests__/review-gating.test.ts
git commit -m "feat(post-consult): pure helpers for outcome mapping, sweep predicates, review-gating"
```

---

## Task 3: Outcome API route + no-show PATCH tweak

**Files:**
- Create: `src/app/api/appointments/[id]/outcome/route.ts`
- Modify: `src/app/api/appointments/route.ts` (clear `outcome_review_pending` on terminal transitions)

- [ ] **Step 1: Implement the outcome route**

Create `src/app/api/appointments/[id]/outcome/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { outcomeToLeadStatus } from '@/lib/appointments/outcome'
import { z } from 'zod'

const schema = z.object({
  outcome: z.enum(['treatment_accepted','deposit_paid','considering','declined','referred_out','no_decision']),
  reason: z.enum(['price','financing','timing','second_opinion','medical','spouse_partner','other']).optional(),
  quoted_value_cents: z.number().int().min(0).max(100_000_00).optional(),
  notes: z.string().max(5000).optional(),
  follow_up_at: z.string().optional(), // ISO
})

// POST /api/appointments/[id]/outcome — record a consult outcome (marks "showed")
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = schema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }

  const { data: profile } = await supabase.from('user_profiles').select('id').single()
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // BOLA: appointment must belong to this org.
  const { data: appt, error: apptErr } = await supabase
    .from('appointments')
    .update({
      status: 'completed',
      consult_outcome: parsed.data.outcome,
      consult_outcome_reason: parsed.data.outcome === 'declined' ? (parsed.data.reason ?? null) : null,
      quoted_value_cents: parsed.data.quoted_value_cents ?? null,
      outcome_notes: parsed.data.notes ?? null,
      outcome_follow_up_at: parsed.data.follow_up_at ?? null,
      outcome_recorded_at: new Date().toISOString(),
      outcome_recorded_by: profile.id,
      outcome_review_pending: false,
    })
    .eq('id', id)
    .eq('organization_id', orgId)
    .select('*, lead:leads(id, first_name, last_name)')
    .single()

  if (apptErr || !appt) {
    return NextResponse.json({ error: apptErr?.message || 'Not found' }, { status: apptErr ? 500 : 404 })
  }

  const lead = appt.lead as { id: string } | null
  if (lead) {
    await supabase.from('leads').update({ status: outcomeToLeadStatus(parsed.data.outcome) }).eq('id', lead.id)
    await supabase.from('lead_activities').insert({
      organization_id: orgId,
      lead_id: lead.id,
      user_id: profile.id,
      activity_type: 'consult_outcome_recorded',
      title: `Consult outcome: ${parsed.data.outcome.replace(/_/g, ' ')}`,
      description: parsed.data.notes ?? null,
      metadata: {
        appointment_id: id,
        outcome: parsed.data.outcome,
        reason: parsed.data.reason ?? null,
        quoted_value_cents: parsed.data.quoted_value_cents ?? null,
      },
    })
  }

  return NextResponse.json({ appointment: appt })
}
```

- [ ] **Step 2: Clear `outcome_review_pending` on terminal PATCH transitions**

In `src/app/api/appointments/route.ts`, inside `PATCH`, find the block that builds `updateData` (around line 218):

```ts
  const updateData: Record<string, unknown> = { status }
  if (notes !== undefined) updateData.notes = notes
```

Add right after it:

```ts
  // A terminal decision clears the "needs outcome" flag so it leaves the queue.
  if (['completed', 'no_show', 'canceled', 'rescheduled'].includes(status)) {
    updateData.outcome_review_pending = false
  }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Manual sanity (optional, if dev DB available)**

Run the dev server and `POST /api/appointments/<id>/outcome` with `{ "outcome": "treatment_accepted" }`; confirm the appointment becomes `completed` with `outcome_recorded_at` set and a `consult_outcome_recorded` activity appears.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/appointments/[id]/outcome/route.ts src/app/api/appointments/route.ts
git commit -m "feat(post-consult): outcome API route + clear review flag on terminal transitions"
```

---

## Task 4: Appointments page — Needs-Outcome tab, past-appointment actions, outcome dialog

**Files:**
- Create: `src/components/crm/consult-outcome-dialog.tsx`
- Modify: `src/app/(dashboard)/appointments/page.tsx`

- [ ] **Step 1: Build the outcome dialog component**

Create `src/components/crm/consult-outcome-dialog.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Loader2 } from 'lucide-react'

const OUTCOMES = [
  { value: 'treatment_accepted', label: 'Treatment accepted' },
  { value: 'deposit_paid', label: 'Deposit paid' },
  { value: 'considering', label: 'Considering / thinking it over' },
  { value: 'declined', label: 'Declined' },
  { value: 'referred_out', label: 'Referred out' },
  { value: 'no_decision', label: 'No decision yet' },
] as const

const REASONS = [
  { value: 'price', label: 'Price' },
  { value: 'financing', label: 'Financing' },
  { value: 'timing', label: 'Timing' },
  { value: 'second_opinion', label: 'Wants a second opinion' },
  { value: 'medical', label: 'Medical' },
  { value: 'spouse_partner', label: 'Spouse/partner to decide' },
  { value: 'other', label: 'Other' },
] as const

export function ConsultOutcomeDialog({
  appointmentId, patientName, open, onOpenChange, onSaved,
}: {
  appointmentId: string
  patientName: string
  open: boolean
  onOpenChange: (v: boolean) => void
  onSaved: () => void
}) {
  const [outcome, setOutcome] = useState<string>('')
  const [reason, setReason] = useState<string>('')
  const [quotedDollars, setQuotedDollars] = useState<string>('')
  const [notes, setNotes] = useState<string>('')
  const [followUp, setFollowUp] = useState<string>('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!outcome) return
    setSaving(true)
    try {
      await fetch(`/api/appointments/${appointmentId}/outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outcome,
          reason: outcome === 'declined' && reason ? reason : undefined,
          quoted_value_cents: quotedDollars ? Math.round(parseFloat(quotedDollars) * 100) : undefined,
          notes: notes || undefined,
          follow_up_at: followUp ? new Date(followUp).toISOString() : undefined,
        }),
      })
      onSaved()
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Consult outcome — {patientName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Outcome</Label>
            <Select value={outcome} onValueChange={setOutcome}>
              <SelectTrigger><SelectValue placeholder="Select an outcome" /></SelectTrigger>
              <SelectContent>
                {OUTCOMES.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {outcome === 'declined' && (
            <div className="space-y-1.5">
              <Label>Reason for declining</Label>
              <Select value={reason} onValueChange={setReason}>
                <SelectTrigger><SelectValue placeholder="Select a reason" /></SelectTrigger>
                <SelectContent>
                  {REASONS.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Quoted treatment value (USD, optional)</Label>
            <Input type="number" min="0" step="1" value={quotedDollars}
              onChange={(e) => setQuotedDollars(e.target.value)} placeholder="e.g. 24000" />
          </div>

          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder="What happened in the consult?" rows={3} />
          </div>

          <div className="space-y-1.5">
            <Label>Follow-up date (optional)</Label>
            <Input type="date" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={!outcome || saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Save outcome
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

> If `src/components/ui/select.tsx` or `dialog.tsx` do not exist, add them with `npx shadcn@latest add select dialog` (the repo uses shadcn/ui). Verify import paths against an existing dialog usage in the repo before finalizing.

- [ ] **Step 2: Add the `outcome_review_pending` field to the page's `AppointmentData` type**

In `src/app/(dashboard)/appointments/page.tsx`, add to `type AppointmentData` (after `no_show_risk_score`):

```ts
  outcome_review_pending: boolean
  consult_outcome: string | null
```

- [ ] **Step 3: Add "Needs Outcome" tab state + data**

Change `TabKey`:

```ts
type TabKey = 'upcoming' | 'today' | 'needs_outcome' | 'reminders' | 'analytics'
```

After the `todayApts` computation, add:

```ts
  const needsOutcomeApts = appointments.filter(a => a.outcome_review_pending)
```

Add a dialog state near the other `useState`s:

```ts
  const [outcomeFor, setOutcomeFor] = useState<AppointmentData | null>(null)
```

Add the tab to the tabs array (after `today`):

```ts
          { key: 'needs_outcome', label: 'Needs Outcome', icon: AlertTriangle, count: needsOutcomeApts.length },
```

- [ ] **Step 4: Render the Needs-Outcome list + wire Showed/No-Show for past appts**

In the content area, add a branch for the new tab (render the same `AppointmentCard`, but pass `forceActions` so it shows actions even when past). Update `AppointmentCard`'s signature and the action gate:

Replace the `{!isPast && (` guard around the action rail with:

```tsx
          {(!isPast || forceActions) && (
```

Add `forceActions` + `onRecordOutcome` to `AppointmentCard`'s props and, inside the action rail, when `forceActions` is set, render **Showed** (opens the dialog) alongside **No-Show**:

```tsx
              {forceActions && (
                <Button
                  size="sm"
                  className="flex-1 lg:flex-none text-xs bg-aurea-primary hover:bg-aurea-primary/90"
                  onClick={() => onRecordOutcome(apt)}
                  disabled={isLoading}
                >
                  <CheckCircle2 className="h-3 w-3 mr-1" /> Showed
                </Button>
              )}
```

Wire the new tab's list:

```tsx
      ) : activeTab === 'needs_outcome' ? (
        <div className="space-y-3">
          {needsOutcomeApts.length === 0 ? (
            <Card><CardContent className="flex flex-col items-center py-12">
              <CheckCircle2 className="h-10 w-10 text-muted-foreground mb-3" />
              <p className="font-medium">Nothing waiting on an outcome</p>
              <p className="text-sm text-muted-foreground">Past consults appear here until you log who showed up.</p>
            </CardContent></Card>
          ) : (
            needsOutcomeApts.map((apt) => (
              <AppointmentCard key={apt.id} appointment={apt}
                reminders={reminders.filter(r => r.appointment_id === apt.id)}
                onConfirm={handleConfirm} onStatusChange={handleStatusChange}
                onSendReminder={handleSendReminder} onRecordOutcome={setOutcomeFor}
                forceActions isLoading={actionLoading === apt.id} />
            ))
          )}
        </div>
```

Render the dialog once, before the closing `</div>` of the page:

```tsx
      {outcomeFor && (
        <ConsultOutcomeDialog
          appointmentId={outcomeFor.id}
          patientName={`${outcomeFor.lead?.first_name ?? ''} ${outcomeFor.lead?.last_name ?? ''}`.trim()}
          open={!!outcomeFor}
          onOpenChange={(v) => { if (!v) setOutcomeFor(null) }}
          onSaved={fetchAppointments}
        />
      )}
```

Add the import at the top:

```tsx
import { ConsultOutcomeDialog } from '@/components/crm/consult-outcome-dialog'
```

Give the other `AppointmentCard` call sites the new optional props (`onRecordOutcome={setOutcomeFor}`; `forceActions` omitted defaults to false — make it optional with a default in the destructure: `forceActions = false, onRecordOutcome`).

- [ ] **Step 5: Typecheck + lint the page**

Run: `npx tsc --noEmit`
Expected: PASS. Fix any prop-type mismatches on `AppointmentCard`.

- [ ] **Step 6: Verify in the browser (preview tools)**

Start the dev server, open `/appointments`, confirm the **Needs Outcome** tab renders, a past appointment shows **Showed** / **No-Show**, and clicking **Showed** opens the dialog. Submit an outcome and confirm the card leaves the queue.

- [ ] **Step 7: Commit**

```bash
git add src/components/crm/consult-outcome-dialog.tsx "src/app/(dashboard)/appointments/page.tsx"
git commit -m "feat(post-consult): Needs-Outcome queue + Showed action + outcome dialog"
```

---

## Task 5: In-app bell — appointments UPDATE listener

**Files:**
- Modify: `src/lib/hooks/use-realtime-notifications.ts`

- [ ] **Step 1: Add an UPDATE handler to the appointments channel**

In the `appointmentsChannel` chain (after the existing `.on('postgres_changes', { event: 'INSERT', … })` block, before `.subscribe()`), add:

```ts
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'appointments',
          filter: `organization_id=eq.${organization.id}`,
        },
        (payload) => {
          const appt = payload.new as Record<string, unknown>
          const old = payload.old as Record<string, unknown>
          // Only fire when the "needs outcome" flag flips on.
          if (appt.outcome_review_pending === true && old.outcome_review_pending !== true) {
            addNotification({
              type: 'appointment_needs_outcome',
              title: 'Appointment needs an outcome',
              description: `${(appt.type as string)?.replace(/_/g, ' ')} — did the patient show?`,
              actionUrl: '/appointments',
            })
            toast.info('An appointment needs an outcome logged', {
              action: { label: 'Review', onClick: () => router.push('/appointments') },
            })
          }
        }
      )
```

> If the notification store's `type` field is a strict union, add `'appointment_needs_outcome'` to it in `src/lib/store/use-notifications.ts`.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (add the union member if it errors).

- [ ] **Step 3: Commit**

```bash
git add src/lib/hooks/use-realtime-notifications.ts src/lib/store/use-notifications.ts
git commit -m "feat(post-consult): in-app bell when an appointment needs an outcome"
```

---

## Task 6: Cron — attendance sweep + feedback dispatch

**Files:**
- Modify: `src/lib/appointments/post-consult.ts` (add `sweepAttendance`, `dispatchFeedbackRequests`)
- Create: `src/app/api/cron/appointment-outcomes/route.ts`
- Modify: `vercel.json`

- [ ] **Step 1: Add the sweep + dispatch functions to `post-consult.ts`**

Append to `src/lib/appointments/post-consult.ts`:

```ts
import { postSlack } from '@/lib/alerts/slack'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { sendEmailToLead } from '@/lib/messaging/resend'
import { generateFeedbackToken } from '@/lib/feedback/review-gating'
import { decryptField } from '@/lib/encryption'
import { logger } from '@/lib/logger'

/** Pass A: flag ended, undecided appointments and Slack a batched digest. */
export async function sweepAttendance(supabase: SupabaseClient, orgId: string): Promise<number> {
  const now = new Date()
  const { data: candidates } = await supabase
    .from('appointments')
    .select('id, status, scheduled_at, duration_minutes, outcome_prompt_sent_at, type, lead:leads(first_name, last_name)')
    .eq('organization_id', orgId)
    .in('status', ['scheduled', 'confirmed'])
    .is('outcome_prompt_sent_at', null)
    .lt('scheduled_at', now.toISOString())

  const due = (candidates ?? []).filter((a) => shouldPromptOutcome(a as AttendanceCandidate, now))
  if (due.length === 0) return 0

  const ids = due.map((a) => a.id)
  await supabase
    .from('appointments')
    .update({ outcome_review_pending: true, outcome_prompt_sent_at: now.toISOString() })
    .in('id', ids)

  const names = due
    .map((a) => {
      const l = (a as { lead?: { first_name?: string; last_name?: string } }).lead
      return `${l?.first_name ?? ''} ${l?.last_name ?? ''}`.trim() || 'a patient'
    })
    .slice(0, 10)
    .join(', ')
  await postSlack(`🗒️ ${due.length} consult${due.length > 1 ? 's' : ''} need an outcome logged: ${names}`)
  return due.length
}

/** Pass B: send feedback requests for showed + outcome-recorded appointments (opt-in orgs). */
export async function dispatchFeedbackRequests(supabase: SupabaseClient, orgId: string): Promise<number> {
  const { data: settings } = await supabase
    .from('booking_settings')
    .select('feedback_request_enabled, google_review_url, feedback_delay_hours')
    .eq('organization_id', orgId)
    .maybeSingle()

  if (!settings?.feedback_request_enabled || !settings.google_review_url) return 0
  const delayHours = settings.feedback_delay_hours ?? 2
  const now = new Date()

  const { data: candidates } = await supabase
    .from('appointments')
    .select('id, status, outcome_recorded_at, lead_id, lead:leads(id, first_name, phone_formatted, email)')
    .eq('organization_id', orgId)
    .eq('status', 'completed')
    .not('outcome_recorded_at', 'is', null)

  const due = (candidates ?? []).filter((a) =>
    isFeedbackDue(a as FeedbackCandidate, now, delayHours)
  )

  let sent = 0
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '')
  for (const appt of due) {
    // Idempotency: skip if a feedback row already exists for this appointment.
    const { data: existing } = await supabase
      .from('patient_feedback')
      .select('id')
      .eq('appointment_id', appt.id)
      .maybeSingle()
    if (existing) continue

    const lead = (appt as { lead?: { id: string; first_name?: string; phone_formatted?: string; email?: string } }).lead
    if (!lead) continue

    const token = generateFeedbackToken()
    const url = `${base}/feedback/${token}`
    const phone = lead.phone_formatted ? (decryptField(lead.phone_formatted) || null) : null

    let channel: 'sms' | 'email' | null = null
    if (phone) {
      const res = await sendSMSToLead({
        supabase, leadId: lead.id, to: phone, caller: 'post_consult.feedback',
        body: `Thanks for visiting today${lead.first_name ? `, ${lead.first_name}` : ''}! How did it go? Tap to rate your visit: ${url} (reply STOP to opt out)`,
      }).catch(() => ({ sent: false }))
      if ((res as { sent?: boolean }).sent) channel = 'sms'
    }
    if (!channel && lead.email) {
      const res = await sendEmailToLead({
        supabase, leadId: lead.id, to: lead.email, caller: 'post_consult.feedback',
        subject: 'How was your visit?',
        html: `<p>Thanks for visiting today${lead.first_name ? `, ${lead.first_name}` : ''}!</p><p>We'd love your quick feedback — <a href="${url}">tap here to rate your visit</a>.</p>`,
        text: `Thanks for visiting today! Rate your visit: ${url}`,
      }).catch(() => ({ sent: false }))
      if ((res as { sent?: boolean }).sent) channel = 'email'
    }
    if (!channel) continue

    await supabase.from('patient_feedback').insert({
      organization_id: orgId, lead_id: lead.id, appointment_id: appt.id,
      token, channel, status: 'requested',
    })
    sent++
  }

  if (sent > 0) logger.info('Feedback requests dispatched', { orgId, sent })
  return sent
}
```

- [ ] **Step 2: Create the cron route**

Create `src/app/api/cron/appointment-outcomes/route.ts` (copy the auth + per-org shape from `src/app/api/cron/reminders/route.ts`):

```ts
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { sweepAttendance, dispatchFeedbackRequests } from '@/lib/appointments/post-consult'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()
  const { data: orgs } = await supabase.from('organizations').select('id')
  if (!orgs?.length) return NextResponse.json({ message: 'No organizations', flagged: 0, feedback_sent: 0 })

  let flagged = 0, feedbackSent = 0
  const errors: string[] = []
  for (const org of orgs) {
    try { flagged += await sweepAttendance(supabase, org.id) }
    catch (e) { errors.push(`sweep ${org.id}: ${e instanceof Error ? e.message : 'err'}`) }
    try { feedbackSent += await dispatchFeedbackRequests(supabase, org.id) }
    catch (e) { errors.push(`feedback ${org.id}: ${e instanceof Error ? e.message : 'err'}`) }
  }

  const summary = { success: true, flagged, feedback_sent: feedbackSent, orgs_processed: orgs.length, errors: errors.slice(0, 20), timestamp: new Date().toISOString() }
  logger.info('appointment-outcomes cron completed', summary)
  return NextResponse.json(summary)
}

export async function GET(request: NextRequest) { return POST(request) }
```

- [ ] **Step 3: Register the cron in `vercel.json`**

Add to the `crons` array:

```json
    {
      "path": "/api/cron/appointment-outcomes",
      "schedule": "*/30 * * * *"
    }
```

- [ ] **Step 4: Typecheck + run the full test suite**

Run: `npx tsc --noEmit` → PASS
Run: `npm run test` → all green (the predicate tests already cover `shouldPromptOutcome`/`isFeedbackDue`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/appointments/post-consult.ts src/app/api/cron/appointment-outcomes/route.ts vercel.json
git commit -m "feat(post-consult): cron for attendance sweep + feedback dispatch"
```

---

## Task 7: Public feedback page + submit API + service-recovery

**Files:**
- Create: `src/app/api/feedback/[token]/route.ts`
- Create: `src/app/feedback/[token]/page.tsx`

- [ ] **Step 1: Implement the submit API**

Create `src/app/api/feedback/[token]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { classifyFeedback } from '@/lib/feedback/review-gating'
import { postSlack } from '@/lib/alerts/slack'
import { z } from 'zod'

const schema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(2000).optional(),
})

// POST /api/feedback/[token] — public; guarded by the unguessable token, not auth.
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const parsed = schema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 })

  const supabase = createServiceClient()
  const { data: fb } = await supabase
    .from('patient_feedback')
    .select('id, organization_id, lead_id, status')
    .eq('token', token)
    .maybeSingle()
  if (!fb) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (fb.status !== 'requested') return NextResponse.json({ alreadyResponded: true })

  const { data: settings } = await supabase
    .from('booking_settings')
    .select('google_review_url, feedback_promoter_threshold')
    .eq('organization_id', fb.organization_id)
    .maybeSingle()
  const threshold = settings?.feedback_promoter_threshold ?? 4

  const { sentiment, routedToReview } = classifyFeedback(parsed.data.rating, threshold)

  await supabase.from('patient_feedback').update({
    status: 'responded', responded_at: new Date().toISOString(),
    rating: parsed.data.rating, comment: parsed.data.comment ?? null,
    sentiment, routed_to_review: routedToReview,
  }).eq('id', fb.id)

  await supabase.from('lead_activities').insert({
    organization_id: fb.organization_id, lead_id: fb.lead_id,
    activity_type: 'patient_feedback_received',
    title: `Patient rated their visit ${parsed.data.rating}★`,
    description: parsed.data.comment ?? null,
    metadata: { rating: parsed.data.rating, sentiment, routed_to_review: routedToReview },
  })

  if (!routedToReview) {
    // Detractor: alert staff for service recovery; never route to public review.
    await postSlack(`⚠️ Patient rated a consult ${parsed.data.rating}★${parsed.data.comment ? `: "${parsed.data.comment}"` : ''} — follow up for service recovery.`)
    return NextResponse.json({ ok: true, routedToReview: false })
  }
  return NextResponse.json({ ok: true, routedToReview: true, reviewUrl: settings?.google_review_url ?? null })
}
```

- [ ] **Step 2: Implement the public page**

Create `src/app/feedback/[token]/page.tsx` (client component; keeps the flow simple):

```tsx
'use client'

import { useState, use } from 'react'

export default function FeedbackPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const [state, setState] = useState<'rate' | 'comment' | 'done' | 'error'>('rate')
  const [rating, setRating] = useState(0)
  const [comment, setComment] = useState('')

  const submit = async (finalComment?: string) => {
    const res = await fetch(`/api/feedback/${token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating, comment: finalComment }),
    })
    if (!res.ok) { setState('error'); return }
    const data = await res.json()
    if (data.routedToReview && data.reviewUrl) { window.location.href = data.reviewUrl; return }
    setState('done')
  }

  const pick = (n: number) => {
    setRating(n)
    if (n >= 4) { setRating(n); setTimeout(() => submitWith(n), 0) } // promoters go straight through
    else setState('comment')
  }
  const submitWith = async (n: number) => {
    const res = await fetch(`/api/feedback/${token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: n }),
    })
    const data = await res.json().catch(() => ({}))
    if (data.routedToReview && data.reviewUrl) { window.location.href = data.reviewUrl; return }
    setState('done')
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-neutral-50">
      <div className="max-w-sm w-full bg-white rounded-2xl shadow-sm p-8 text-center">
        {state === 'rate' && (
          <>
            <h1 className="text-xl font-semibold mb-2">How was your visit?</h1>
            <p className="text-sm text-neutral-500 mb-6">Tap a star to rate your experience.</p>
            <div className="flex justify-center gap-2 text-3xl">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} aria-label={`${n} stars`} onClick={() => pick(n)} className="hover:scale-110 transition">
                  {n <= rating ? '★' : '☆'}
                </button>
              ))}
            </div>
          </>
        )}
        {state === 'comment' && (
          <>
            <h1 className="text-xl font-semibold mb-2">Sorry it wasn’t perfect.</h1>
            <p className="text-sm text-neutral-500 mb-4">Tell us what we could have done better — this goes straight to the team.</p>
            <textarea className="w-full border rounded-lg p-3 text-sm" rows={4} value={comment}
              onChange={(e) => setComment(e.target.value)} placeholder="Your feedback" />
            <button className="mt-4 w-full bg-neutral-900 text-white rounded-lg py-2.5 text-sm"
              onClick={() => submit(comment)}>Send feedback</button>
          </>
        )}
        {state === 'done' && <h1 className="text-xl font-semibold">Thank you! 🙏</h1>}
        {state === 'error' && <p className="text-sm text-neutral-500">This link is no longer valid.</p>}
      </div>
    </main>
  )
}
```

> Simplify: the page has both a `submit` and `submitWith` path; consolidate into one during implementation if preferred, but keep the behaviour — ≥4★ submits immediately and redirects to the review URL; ≤3★ collects a comment first.

- [ ] **Step 3: Typecheck + browser check**

Run: `npx tsc --noEmit` → PASS.
Insert a test `patient_feedback` row (or use one created by the cron), open `/feedback/<token>`, submit 5★ → redirect to the configured review URL; submit 2★ + comment → "Thank you" + a Slack service-recovery alert + a `patient_feedback_received` activity on the lead. Re-submitting the same token returns the "already responded" state.

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/feedback/[token]/route.ts" "src/app/feedback/[token]/page.tsx"
git commit -m "feat(post-consult): public feedback page + review-gating submit + service-recovery alert"
```

---

## Task 8: Settings — feedback config

**Files:**
- Modify: `src/app/api/settings/booking-protocol/route.ts`
- Modify: `src/components/settings/booking-protocol-settings.tsx`

- [ ] **Step 1: Extend the API allow-list**

In `src/app/api/settings/booking-protocol/route.ts`:

Update `PROTOCOL_COLUMNS`:

```ts
const PROTOCOL_COLUMNS =
  'require_call_before_booking, no_show_fee_enabled, no_show_fee_cents, youtube_testimonial_url, consult_price_range_text, discovery_script, feedback_request_enabled, google_review_url, feedback_promoter_threshold, feedback_delay_hours'
```

Add the defaults in the GET fallback object:

```ts
      feedback_request_enabled: false,
      google_review_url: null,
      feedback_promoter_threshold: 4,
      feedback_delay_hours: 2,
```

Add to `patchSchema`:

```ts
  feedback_request_enabled: z.boolean().optional(),
  google_review_url: z.string().url().max(500).nullish().or(z.literal('')),
  feedback_promoter_threshold: z.number().int().min(1).max(5).optional(),
  feedback_delay_hours: z.number().int().min(0).max(168).optional(),
```

And normalise the empty string in the PATCH body (next to the other normalisations):

```ts
  if (update.google_review_url === '') update.google_review_url = null
```

- [ ] **Step 2: Add the UI section**

In `src/components/settings/booking-protocol-settings.tsx`, extend `ProtocolSettings` + `DEFAULTS`:

```ts
  feedback_request_enabled: boolean
  google_review_url: string | null
  feedback_promoter_threshold: number
  feedback_delay_hours: number
```

```ts
  feedback_request_enabled: false,
  google_review_url: null,
  feedback_promoter_threshold: 4,
  feedback_delay_hours: 2,
```

Add a "Patient feedback" section in the form (mirror the existing Switch + Input rows already in the file):

```tsx
        <div className="space-y-4 border-t pt-6">
          <div className="flex items-center justify-between">
            <div>
              <Label>Request feedback after consults</Label>
              <p className="text-sm text-muted-foreground">Text/email attendees a quick rating; happy patients are invited to leave a public review.</p>
            </div>
            <Switch
              checked={settings.feedback_request_enabled}
              onCheckedChange={(v) => setSettings((s) => ({ ...s, feedback_request_enabled: v }))}
            />
          </div>
          {settings.feedback_request_enabled && (
            <>
              <div className="space-y-1.5">
                <Label>Google review link</Label>
                <Input
                  value={settings.google_review_url ?? ''}
                  onChange={(e) => setSettings((s) => ({ ...s, google_review_url: e.target.value }))}
                  placeholder="https://g.page/r/…/review"
                />
                <p className="text-xs text-muted-foreground">Required — no feedback is sent until this is set.</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Send feedback after (hours)</Label>
                  <Input type="number" min="0" max="168" value={settings.feedback_delay_hours}
                    onChange={(e) => setSettings((s) => ({ ...s, feedback_delay_hours: parseInt(e.target.value || '0', 10) }))} />
                </div>
                <div className="space-y-1.5">
                  <Label>Route to review at (stars)</Label>
                  <Input type="number" min="1" max="5" value={settings.feedback_promoter_threshold}
                    onChange={(e) => setSettings((s) => ({ ...s, feedback_promoter_threshold: parseInt(e.target.value || '4', 10) }))} />
                </div>
              </div>
            </>
          )}
        </div>
```

Ensure the PATCH `handleSave` body includes the four new fields (if it sends the whole `settings` object, no change needed; otherwise add them).

- [ ] **Step 3: Typecheck + browser check**

Run: `npx tsc --noEmit` → PASS.
Open Settings → Booking protocol, toggle feedback on, save a Google review URL, reload, confirm it persisted.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/settings/booking-protocol/route.ts src/components/settings/booking-protocol-settings.tsx
git commit -m "feat(post-consult): settings for patient-feedback opt-in"
```

---

## Task 9: Analytics cards + final verification

**Files:**
- Modify: `src/app/(dashboard)/appointments/page.tsx` (`NoShowAnalyticsTab`)

- [ ] **Step 1: Add Consult-Outcomes + Feedback cards**

In `NoShowAnalyticsTab`, after the "Channel Effectiveness" card, add a Consult Outcomes card computed from `appointments` that have `consult_outcome`:

```tsx
      {(() => {
        const withOutcome = appointments.filter(a => a.consult_outcome)
        const attended = withOutcome.length || 1
        const accepted = withOutcome.filter(a => a.consult_outcome === 'treatment_accepted' || a.consult_outcome === 'deposit_paid').length
        const acceptRate = Math.round((accepted / attended) * 100)
        return (
          <Card>
            <CardHeader><CardTitle className="text-base">Consult Outcomes</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4 text-center">
                <div><p className="aurea-display text-[28px] text-aurea-primary tabular-nums">{acceptRate}%</p><p className="text-[12px] text-aurea-ink-3">Acceptance</p></div>
                <div><p className="aurea-display text-[28px] tabular-nums">{withOutcome.length}</p><p className="text-[12px] text-aurea-ink-3">Outcomes logged</p></div>
                <div><p className="aurea-display text-[28px] tabular-nums">{withOutcome.filter(a => a.consult_outcome === 'considering').length}</p><p className="text-[12px] text-aurea-ink-3">Considering</p></div>
              </div>
            </CardContent>
          </Card>
        )
      })()}
```

> A Feedback card (avg rating, response rate, reviews routed) requires the page to also fetch `patient_feedback`. If you want it now, add a `fetch('/api/feedback/summary')` endpoint (org-scoped aggregate) and a card; otherwise leave a TODO-free note that feedback analytics ship in a follow-up. Keep this task scoped: ship the Consult-Outcomes card, which needs no new endpoint.

- [ ] **Step 2: Full verification pass**

Run: `npx tsc --noEmit` → PASS
Run: `npm run test` → all green
Run: `npm run build` → succeeds (matches the Vercel build).

- [ ] **Step 3: Commit**

```bash
git add "src/app/(dashboard)/appointments/page.tsx"
git commit -m "feat(post-consult): consult-outcome analytics card"
```

- [ ] **Step 4: Open the PR**

```bash
git push -u origin <branch>
gh pr create --title "feat(post-consult): attendance confirmation + consult outcomes + patient feedback" --body "Implements docs/superpowers/specs/2026-07-01-post-consult-flow-design.md. Attendance-review queue + Slack alerts (on by default), structured consult outcomes, and an opt-in review-gating patient-feedback funnel (SMS-first, email fallback)."
```

---

## Self-Review (completed)

- **Spec coverage:** ① attendance (Tasks 3–6) · ② structured outcome (Tasks 1–4) · ③ review-gating feedback (Tasks 6–7) · in-app + Slack alerts (Tasks 5–6) · opt-in settings (Task 8) · analytics (Task 9). All spec sections mapped.
- **Placeholders:** The only forward-looking note is the optional Feedback analytics card in Task 9, explicitly scoped out with the Consult-Outcomes card shipping — not a placeholder in shipped code.
- **Type consistency:** `ConsultOutcome`/`ConsultOutcomeReason`/`PatientFeedback` defined in Task 1 and reused verbatim in Tasks 2–8; `outcomeToLeadStatus`, `shouldPromptOutcome`, `isFeedbackDue`, `classifyFeedback`, `generateFeedbackToken`, `sweepAttendance`, `dispatchFeedbackRequests` names are stable across tasks. The unique index on `patient_feedback(appointment_id)` matches the cron's per-appointment idempotency check.
```
