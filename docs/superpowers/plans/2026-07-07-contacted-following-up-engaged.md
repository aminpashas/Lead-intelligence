# Contacted → Following Up + Engaged Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the single 23,327-lead "Contacted" pipeline column into two meaningful, self-maintaining states — **Following Up** (in active cadence, no reply yet) and **Engaged** (they replied) — with an on-card Day-N cadence timeline and automatic transitions, so a stalled lead can never hide behind a fresh one.

**Architecture:** Rename the existing `contacted` stage's *display name* to "Following Up" (slug stays `contacted`, so all 23k leads and ~40 GHL stage-name mappings keep working with zero churn). Add exactly one new stage, `engaged`. A pure classifier (timestamps → state) drives: (a) a one-time SQL backfill of existing leads, (b) auto-transitions in the encounter processor, and (c) a Day-N badge on each card. All state/board/backfill changes are send-safe and ship under the active `MESSAGING_DRY_RUN=1` hard-stop; actually enrolling leads into live sends is a separate switch, out of scope here.

**Tech Stack:** Next.js 16 (App Router, RSC), TypeScript, Supabase Postgres (RLS, `pipeline_stages` + `leads`), vitest for pure-unit tests. Board groups leads by `leads.stage_id`.

---

## Background facts (verified against the codebase — do not re-derive)

- **Board grouping key is `leads.stage_id`** (FK → `pipeline_stages.id`), NOT `leads.status`. See `src/app/(dashboard)/pipeline/page.tsx` (per-stage query `.eq('stage_id', s.id)`) and `src/components/crm/pipeline-board.tsx` (`leads.filter(l => l.stage_id === stage.id)`).
- **`pipeline_stages`** has columns `id, organization_id, name, slug, color, position, is_default, is_won, is_lost` with `unique(organization_id, slug)`. Default rows are seeded by trigger `seed_default_pipeline_stages()` `AFTER INSERT ON organizations` in `supabase/migrations/002_leads_and_pipeline.sql`. The trigger does NOT run for existing orgs.
- **`leads.status`** is a separate CHECK enum using **underscores** (`'contacted'`, `'consultation_scheduled'`, …). Slugs use **dashes** (`'consultation-scheduled'`). The enum has NO `engaged`/`following_up`/`nurturing` values. We do NOT add `engaged` to the status enum — Engaged is a **stage**, and `status` stays as-is (existing code filters on it).
- **Reconcile writer** (`src/lib/ghl/reconcile.ts`) writes `leads.stage_id` by resolving `LiStageSlug` → row id via `loadStageMap()`, which **throws if any `NATIVE` slug is missing** a row. `PRIORITY: Record<LiStageSlug, number>` is exhaustively keyed (TS). `hasLiEngagement()` + `DEMOTING_SLUGS` prevent GHL from demoting a lead LI knows is engaged.
- **Timestamps on `leads`:** `last_contacted_at`, `last_responded_at`, `first_contact_at`, plus counters `total_messages_received` / `total_sms_received`.
- **`follow_up_enrollments`:** `unique(lead_id)`, columns `status ('active'|'completed'|'stopped')`, `current_step int default 0`, `enrolled_at`, `last_step_sent_at`.
- **Cadence source of truth:** `src/lib/followup/sequence.ts` `DEFAULT_FOLLOWUP_SEQUENCE` (currently 3 steps: day 0/2/4).
- **Tests:** vitest, in `src/lib/__tests__/`, pure functions, no I/O mocks. Run a single file with `npx vitest run src/lib/__tests__/<file>`.
- **Migrations are applied** with `supabase db query --linked -f <file>` (NOT `db push`). Do not run this yourself — the plan flags apply points for the user.

## Classification thresholds (single source of truth — used by TS classifier AND SQL backfill)

A lead currently sitting on the `contacted` (Following Up) stage is reclassified as:

- **`engaged`** — the lead has replied: `last_responded_at IS NOT NULL AND (last_contacted_at IS NULL OR last_responded_at >= last_contacted_at)` **OR** `total_messages_received > 0`.
- **`nurturing`** — silent and cold: not engaged **AND** `last_contacted_at IS NOT NULL AND last_contacted_at < now() - interval '14 days'` (i.e. cadence window is exhausted).
- **`following-up`** — everything else (recently contacted, or never contacted, awaiting a reply).

`ENGAGED_MAX_CADENCE_DAYS = 14` is the boundary. Keep the TS constant and the SQL interval in lockstep; each references the other in a comment.

## File Structure

- **Create** `supabase/migrations/20260707120000_following_up_engaged_stages.sql` — rename `contacted`→"Following Up", insert `engaged` per org, ensure `nurturing` row exists per org, update the seed trigger, backfill `stage_id` for existing `contacted` leads.
- **Create** `src/lib/pipeline/contacted-state.ts` — pure classifier + cadence-timeline model. One responsibility: given a lead's timestamps + enrollment, return its state and Day-N badge data.
- **Create** `src/lib/__tests__/contacted-state.test.ts` — vitest unit tests for the classifier + timeline.
- **Modify** `src/lib/followup/sequence.ts` — extend `DEFAULT_FOLLOWUP_SEQUENCE` to the front-loaded 8-touch schedule.
- **Modify** `src/lib/__tests__/follow-up-sequence.test.ts` — update expectations for 8 steps.
- **Modify** `src/lib/ghl/reconcile-map.ts` — add `'engaged'` to `LiStageSlug`.
- **Modify** `src/lib/ghl/reconcile.ts` — thread `'engaged'` through `PRIORITY`, `NATIVE`, and engagement/demotion logic.
- **Modify** `src/lib/__tests__/ghl-reconcile-map.test.ts` (+ `ghl-reconcile-engagement.test.ts`) — assert engaged is highest non-terminal priority and is not demoted.
- **Modify** `src/lib/pipeline/stage-groups.ts` — no new group, but export an `ACTIVE_CONTACT_STAGE_SLUGS` helper used by the badge query.
- **Create** `src/components/crm/lead-cadence-badge.tsx` — renders the Day-N badge from the timeline model.
- **Modify** `src/components/crm/pipeline-board.tsx` (or the lead-card component it renders) — mount the badge.
- **Modify** `src/app/(dashboard)/pipeline/page.tsx` — include enrollment + timestamps in the per-stage lead query and pass through.
- **Modify** `src/lib/ai/encounter-processor.ts` — set `stage_id` (not just `status`) on first contact (→ `contacted`) and on inbound reply (→ `engaged`).

---

## Phase 1 — Pure classifier + cadence timeline (no I/O, TDD first)

### Task 1: Cadence — extend the default sequence to 8 front-loaded touches

**Files:**
- Modify: `src/lib/followup/sequence.ts:12-16`
- Test: `src/lib/__tests__/follow-up-sequence.test.ts`

- [ ] **Step 1: Update the failing test first**

Open `src/lib/__tests__/follow-up-sequence.test.ts` and replace the block that asserts the default sequence length/shape with:

```ts
import { DEFAULT_FOLLOWUP_SEQUENCE, isComplete, nextDueStep } from '@/lib/followup/sequence'

describe('DEFAULT_FOLLOWUP_SEQUENCE', () => {
  it('is a front-loaded 8-touch schedule over ~14 days', () => {
    expect(DEFAULT_FOLLOWUP_SEQUENCE.map((s) => s.day)).toEqual([0, 1, 2, 4, 7, 10, 14, 14])
    expect(DEFAULT_FOLLOWUP_SEQUENCE).toHaveLength(8)
    // heaviest touches in first 48h
    expect(DEFAULT_FOLLOWUP_SEQUENCE.filter((s) => s.day <= 2)).toHaveLength(3)
  })

  it('is complete only after the 8th step', () => {
    expect(isComplete({ current_step: 7 })).toBe(false)
    expect(isComplete({ current_step: 8 })).toBe(true)
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/lib/__tests__/follow-up-sequence.test.ts`
Expected: FAIL (current sequence is length 3, days `[0,2,4]`).

- [ ] **Step 3: Implement the new cadence**

In `src/lib/followup/sequence.ts` replace `DEFAULT_FOLLOWUP_SEQUENCE`:

```ts
/**
 * Default cadence: front-loaded 8 touches over ~14 days. Speed-to-lead — the
 * bulk of the effort lands in the first 48 hours, then tapers to a Day-14
 * breakup. Channels alternate call/text/email to maximise reachability.
 * The final Day-14 SMS is the "breakup" message.
 */
export const DEFAULT_FOLLOWUP_SEQUENCE: SequenceStep[] = [
  { day: 0, channel: 'sms' },
  { day: 1, channel: 'email' },
  { day: 2, channel: 'sms' },
  { day: 4, channel: 'email' },
  { day: 7, channel: 'sms' },
  { day: 10, channel: 'email' },
  { day: 14, channel: 'email' },
  { day: 14, channel: 'sms' },
]
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run src/lib/__tests__/follow-up-sequence.test.ts`
Expected: PASS. If any other assertion in that file hard-codes 3 steps, update it to the new schedule.

- [ ] **Step 5: Commit**

```bash
git add src/lib/followup/sequence.ts src/lib/__tests__/follow-up-sequence.test.ts
git commit -m "feat(followup): front-loaded 8-touch default cadence"
```

### Task 2: Pure classifier + timeline model

**Files:**
- Create: `src/lib/pipeline/contacted-state.ts`
- Test: `src/lib/__tests__/contacted-state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/contacted-state.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  classifyContactedState,
  cadenceTimeline,
  ENGAGED_MAX_CADENCE_DAYS,
} from '@/lib/pipeline/contacted-state'

const DAY = 24 * 60 * 60 * 1000
const now = Date.parse('2026-07-07T00:00:00Z')

describe('classifyContactedState', () => {
  it('is engaged when the lead has replied after our last outreach', () => {
    expect(
      classifyContactedState({
        last_contacted_at: '2026-07-05T00:00:00Z',
        last_responded_at: '2026-07-06T00:00:00Z',
        total_messages_received: 0,
      }, now)
    ).toBe('engaged')
  })

  it('is engaged when any inbound message exists even without a response timestamp', () => {
    expect(
      classifyContactedState({
        last_contacted_at: '2026-07-05T00:00:00Z',
        last_responded_at: null,
        total_messages_received: 2,
      }, now)
    ).toBe('engaged')
  })

  it('is following-up when recently contacted and no reply', () => {
    expect(
      classifyContactedState({
        last_contacted_at: '2026-07-04T00:00:00Z',
        last_responded_at: null,
        total_messages_received: 0,
      }, now)
    ).toBe('following-up')
  })

  it('is nurturing when silent past the cadence window', () => {
    expect(
      classifyContactedState({
        last_contacted_at: '2026-06-01T00:00:00Z',
        last_responded_at: null,
        total_messages_received: 0,
      }, now)
    ).toBe('nurturing')
  })

  it('is following-up when never contacted (awaiting first touch)', () => {
    expect(
      classifyContactedState({
        last_contacted_at: null,
        last_responded_at: null,
        total_messages_received: 0,
      }, now)
    ).toBe('following-up')
  })
})

describe('cadenceTimeline', () => {
  it('reports Day-N and next-touch for an active enrollment', () => {
    const tl = cadenceTimeline({
      enrollment: { status: 'active', current_step: 3, enrolled_at: '2026-07-01T00:00:00Z' },
      now,
    })
    expect(tl.dayN).toBe(6) // 2026-07-07 is 6 days after enrollment
    expect(tl.stepIndex).toBe(3)
    expect(tl.totalSteps).toBe(8)
    // next step is day 4 from enrolled_at → 2026-07-05, already past → due now
    expect(tl.nextTouchAtMs).toBe(Date.parse('2026-07-05T00:00:00Z'))
    expect(tl.exhausted).toBe(false)
  })

  it('flags exhausted when the enrollment completed', () => {
    const tl = cadenceTimeline({
      enrollment: { status: 'completed', current_step: 8, enrolled_at: '2026-06-20T00:00:00Z' },
      now,
    })
    expect(tl.exhausted).toBe(true)
    expect(tl.nextTouchAtMs).toBeNull()
  })

  it('returns null timeline when there is no enrollment', () => {
    expect(cadenceTimeline({ enrollment: null, now })).toBeNull()
  })

  it('exports the 14-day boundary constant', () => {
    expect(ENGAGED_MAX_CADENCE_DAYS).toBe(14)
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/lib/__tests__/contacted-state.test.ts`
Expected: FAIL with "Cannot find module '@/lib/pipeline/contacted-state'".

- [ ] **Step 3: Implement the module**

Create `src/lib/pipeline/contacted-state.ts`:

```ts
/**
 * Pure classification of a lead sitting in the "Following Up" funnel plus the
 * Day-N cadence timeline shown on its card. No I/O — the SQL backfill, the
 * encounter processor, and the card badge all reason off these functions so the
 * board and the database never disagree.
 *
 * The thresholds here are mirrored verbatim by the SQL backfill in
 * supabase/migrations/20260707120000_following_up_engaged_stages.sql. If you
 * change ENGAGED_MAX_CADENCE_DAYS, change the SQL interval too.
 */

import { DEFAULT_FOLLOWUP_SEQUENCE, stepDueAt } from '@/lib/followup/sequence'

/** A lead is out of active cadence after this many days of silence. */
export const ENGAGED_MAX_CADENCE_DAYS = 14

const DAY = 24 * 60 * 60 * 1000

export type ContactedState = 'following-up' | 'engaged' | 'nurturing'

export type ContactSignals = {
  last_contacted_at: string | null
  last_responded_at: string | null
  total_messages_received: number | null
}

/** Has the lead replied to us at all? */
export function hasReplied(s: ContactSignals): boolean {
  if ((s.total_messages_received ?? 0) > 0) return true
  if (!s.last_responded_at) return false
  if (!s.last_contacted_at) return true
  return Date.parse(s.last_responded_at) >= Date.parse(s.last_contacted_at)
}

/** Classify a Following-Up lead into its true sub-state. */
export function classifyContactedState(s: ContactSignals, nowMs: number): ContactedState {
  if (hasReplied(s)) return 'engaged'
  if (s.last_contacted_at && Date.parse(s.last_contacted_at) < nowMs - ENGAGED_MAX_CADENCE_DAYS * DAY) {
    return 'nurturing'
  }
  return 'following-up'
}

export type TimelineEnrollment = {
  status: 'active' | 'completed' | 'stopped'
  current_step: number
  enrolled_at: string
}

export type CadenceTimeline = {
  /** Whole days since enrollment (the "Day N" label). */
  dayN: number
  /** 0-based index of the next step to fire. */
  stepIndex: number
  totalSteps: number
  /** Absolute ms of the next scheduled touch, or null if none remain. */
  nextTouchAtMs: number | null
  /** Cadence finished (completed/stopped or past the last step) with no reply. */
  exhausted: boolean
}

/** The Day-N badge model for a card, or null when there is no enrollment. */
export function cadenceTimeline(args: {
  enrollment: TimelineEnrollment | null
  now: number
}): CadenceTimeline | null {
  const { enrollment, now } = args
  if (!enrollment) return null
  const total = DEFAULT_FOLLOWUP_SEQUENCE.length
  const dayN = Math.max(0, Math.floor((now - Date.parse(enrollment.enrolled_at)) / DAY))
  const stepIndex = Math.min(enrollment.current_step, total)
  const exhausted =
    enrollment.status !== 'active' || stepIndex >= total
  const nextTouchAtMs =
    exhausted || stepIndex >= total
      ? null
      : stepDueAt(enrollment.enrolled_at, DEFAULT_FOLLOWUP_SEQUENCE[stepIndex])
  return { dayN, stepIndex, totalSteps: total, nextTouchAtMs, exhausted }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run src/lib/__tests__/contacted-state.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline/contacted-state.ts src/lib/__tests__/contacted-state.test.ts
git commit -m "feat(pipeline): pure classifier + cadence timeline for Following Up/Engaged"
```

---

## Phase 2 — Reconcile threading (keep GHL sync correct, protect Engaged)

### Task 3: Add `engaged` to the GHL stage slug union

**Files:**
- Modify: `src/lib/ghl/reconcile-map.ts:24-37`
- Test: `src/lib/__tests__/ghl-reconcile-map.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/__tests__/ghl-reconcile-map.test.ts`:

```ts
import type { LiStageSlug } from '@/lib/ghl/reconcile-map'

describe('engaged slug', () => {
  it('accepts engaged as a valid LiStageSlug (no GHL name maps to it — LI-derived only)', () => {
    const s: LiStageSlug = 'engaged'
    expect(s).toBe('engaged')
  })
  it('still maps the whole contacted family to contacted (Following Up)', () => {
    expect(resolveReconcileTarget('1st Call')).toEqual({ stageSlug: 'contacted' })
    expect(resolveReconcileTarget('Follow Up Needed')).toEqual({ stageSlug: 'contacted' })
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/lib/__tests__/ghl-reconcile-map.test.ts`
Expected: FAIL — TS: `Type '"engaged"' is not assignable to type 'LiStageSlug'`.

- [ ] **Step 3: Implement**

In `src/lib/ghl/reconcile-map.ts`, add `'engaged'` to the union (right after `'contacted'`). Do NOT add any `STAGE_TABLE` entry — Engaged is assigned by LI signals, never by a GHL stage name:

```ts
export type LiStageSlug =
  | 'new'
  | 'contacted'
  | 'engaged'
  | 'qualified'
  | 'consultation-scheduled'
  | 'consultation-completed'
  | 'treatment-presented'
  | 'financing'
  | 'contract-signed'
  | 'scheduled'
  | 'completed'
  | 'lost'
  | 'no-communication'
  | 'dnd-sms'
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run src/lib/__tests__/ghl-reconcile-map.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ghl/reconcile-map.ts src/lib/__tests__/ghl-reconcile-map.test.ts
git commit -m "feat(ghl): add engaged to LiStageSlug (LI-derived, no GHL mapping)"
```

### Task 4: Thread `engaged` through reconcile priority / native / anti-demotion

**Files:**
- Modify: `src/lib/ghl/reconcile.ts` — `PRIORITY` (≈24-38), `NATIVE` (≈40), `DEMOTING_SLUGS` (≈57), `hasLiEngagement` (≈73-77)
- Test: `src/lib/__tests__/ghl-reconcile-engagement.test.ts`

- [ ] **Step 1: Read the current constants**

Run: `sed -n '20,80p' src/lib/ghl/reconcile.ts` and note the exact shapes of `PRIORITY`, `NATIVE`, `DEMOTING_SLUGS`, `hasLiEngagement`. (They are quoted in the plan header findings; confirm before editing.)

- [ ] **Step 2: Write the failing test**

Append to `src/lib/__tests__/ghl-reconcile-engagement.test.ts` (match its existing imports; it already imports from `@/lib/ghl/reconcile`):

```ts
import { PRIORITY, NATIVE } from '@/lib/ghl/reconcile'

describe('engaged ordering', () => {
  it('ranks engaged above contacted but below qualified', () => {
    expect(PRIORITY.engaged).toBeGreaterThan(PRIORITY.contacted)
    expect(PRIORITY.engaged).toBeLessThan(PRIORITY.qualified)
  })
  it('treats engaged as a native LI stage that must exist per org', () => {
    expect(NATIVE).toContain('engaged')
  })
})
```

If `PRIORITY`/`NATIVE` are not exported, add `export` to their declarations in `reconcile.ts`.

- [ ] **Step 3: Run it, verify it fails**

Run: `npx vitest run src/lib/__tests__/ghl-reconcile-engagement.test.ts`
Expected: FAIL (`PRIORITY.engaged` is undefined; `NATIVE` lacks `engaged`).

- [ ] **Step 4: Implement**

In `src/lib/ghl/reconcile.ts`:

1. Add `engaged` to `PRIORITY` between `contacted` and `qualified`. Renumber so it sits strictly between them, e.g. if `contacted: 5, qualified: 6`, make `contacted: 5, engaged: 6, qualified: 7` and bump every subsequent value by 1. (TS requires every `LiStageSlug` key present.)
2. Add `'engaged'` to the `NATIVE` array (so `loadStageMap` requires the row — the migration in Task 5 creates it).
3. In `hasLiEngagement()`, ensure a lead already on the `engaged` stage counts as engaged: add `currentStageSlug === 'engaged'` to its OR conditions (guard against a GHL "contacted" downgrade).
4. Leave `DEMOTING_SLUGS` as-is unless it enumerates forward stages; if `contacted` is listed as non-demoting, add `engaged` alongside it so GHL "contacted" never pulls an Engaged lead backward.

- [ ] **Step 5: Run tests + full typecheck**

Run: `npx vitest run src/lib/__tests__/ghl-reconcile-engagement.test.ts && npx tsc --noEmit`
Expected: PASS and zero TS errors (this catches any non-exhaustive `Record<LiStageSlug, …>`).

- [ ] **Step 6: Commit**

```bash
git add src/lib/ghl/reconcile.ts src/lib/__tests__/ghl-reconcile-engagement.test.ts
git commit -m "feat(ghl): thread engaged through reconcile priority/native/anti-demotion"
```

---

## Phase 3 — Database migration (rename, add stage, backfill 23k) — SEND-SAFE

### Task 5: Migration — Following Up rename, Engaged stage, Nurturing ensure, backfill

**Files:**
- Create: `supabase/migrations/20260707120000_following_up_engaged_stages.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260707120000_following_up_engaged_stages.sql`:

```sql
-- Following Up + Engaged: split the "Contacted" funnel into two real board states.
-- Send-safe: only pipeline_stages rows and leads.stage_id are touched. No messages.
-- Classification thresholds MIRROR src/lib/pipeline/contacted-state.ts
-- (ENGAGED_MAX_CADENCE_DAYS = 14). Keep them in lockstep.

begin;

-- 1) Rename the display name of the existing 'contacted' stage. Slug is UNCHANGED
--    so all existing leads on this stage and all GHL name→'contacted' mappings
--    keep working with zero data movement.
update public.pipeline_stages
   set name = 'Following Up'
 where slug = 'contacted';

-- 2) Insert an 'engaged' stage per org, positioned immediately after Following Up.
--    Shift everything at/after the contacted position down by one to make room.
do $$
declare
  org record;
  contacted_pos integer;
begin
  for org in select id from public.organizations loop
    select position into contacted_pos
      from public.pipeline_stages
     where organization_id = org.id and slug = 'contacted';
    if contacted_pos is null then
      continue; -- org has no contacted stage; skip
    end if;

    -- make a gap right after Following Up
    update public.pipeline_stages
       set position = position + 1
     where organization_id = org.id
       and position > contacted_pos;

    -- create Engaged if it does not already exist (idempotent)
    insert into public.pipeline_stages (organization_id, name, slug, color, position, is_default)
    select org.id, 'Engaged', 'engaged', '#10B981', contacted_pos + 1, false
     where not exists (
       select 1 from public.pipeline_stages
        where organization_id = org.id and slug = 'engaged'
     );

    -- ensure a Nurturing stage exists (backfill target for cold leads).
    insert into public.pipeline_stages (organization_id, name, slug, color, position, is_default)
    select org.id, 'Nurturing', 'nurturing', '#8B8B8B',
           (select coalesce(max(position), 0) + 1 from public.pipeline_stages where organization_id = org.id),
           false
     where not exists (
       select 1 from public.pipeline_stages
        where organization_id = org.id and slug = 'nurturing'
     );
  end loop;
end $$;

-- 3) Backfill existing leads currently on the Following Up (contacted) stage into
--    Engaged / Nurturing per the classifier. Leads that stay Following Up are left
--    untouched. Won/lost are excluded (their status pins them out of outreach).
do $$
declare
  org record;
  contacted_id uuid;
  engaged_id uuid;
  nurturing_id uuid;
begin
  for org in select id from public.organizations loop
    select id into contacted_id  from public.pipeline_stages where organization_id = org.id and slug = 'contacted';
    select id into engaged_id    from public.pipeline_stages where organization_id = org.id and slug = 'engaged';
    select id into nurturing_id  from public.pipeline_stages where organization_id = org.id and slug = 'nurturing';
    if contacted_id is null then continue; end if;

    -- Engaged: replied to us
    update public.leads l
       set stage_id = engaged_id
     where l.organization_id = org.id
       and l.stage_id = contacted_id
       and l.status not in ('disqualified','lost')
       and (
         coalesce(l.total_messages_received, 0) > 0
         or (l.last_responded_at is not null
             and (l.last_contacted_at is null or l.last_responded_at >= l.last_contacted_at))
       );

    -- Nurturing: silent past the 14-day cadence window (mirror ENGAGED_MAX_CADENCE_DAYS)
    update public.leads l
       set stage_id = nurturing_id
     where l.organization_id = org.id
       and l.stage_id = contacted_id
       and l.status not in ('disqualified','lost')
       and l.last_contacted_at is not null
       and l.last_contacted_at < now() - interval '14 days';
    -- remainder stays on Following Up (contacted)
  end loop;
end $$;

-- 4) Update the seed trigger so NEW orgs get Following Up + Engaged from birth.
create or replace function public.seed_default_pipeline_stages()
returns trigger as $$
begin
  insert into public.pipeline_stages (organization_id, name, slug, color, position, is_default) values
    (new.id, 'New Lead', 'new', '#3B82F6', 0, true),
    (new.id, 'Following Up', 'contacted', '#8B5CF6', 1, false),
    (new.id, 'Engaged', 'engaged', '#10B981', 2, false),
    (new.id, 'Qualified', 'qualified', '#F59E0B', 3, false),
    (new.id, 'Consultation Scheduled', 'consultation-scheduled', '#10B981', 4, false),
    (new.id, 'Consultation Completed', 'consultation-completed', '#14B8A6', 5, false),
    (new.id, 'Treatment Presented', 'treatment-presented', '#0EA5E9', 6, false),
    (new.id, 'Financing', 'financing', '#A855F7', 7, false),
    (new.id, 'Contract Signed', 'contract-signed', '#6366F1', 8, false),
    (new.id, 'Scheduled for Treatment', 'scheduled', '#6366F1', 9, false);

  insert into public.pipeline_stages (organization_id, name, slug, color, position, is_won) values
    (new.id, 'Completed', 'completed', '#22C55E', 10, true);

  insert into public.pipeline_stages (organization_id, name, slug, color, position, is_lost) values
    (new.id, 'Lost', 'lost', '#EF4444', 11, true);

  return new;
end;
$$ language plpgsql;

commit;
```

> Before pasting step 4, run `sed -n '258,290p' supabase/migrations/002_leads_and_pipeline.sql` and copy the CURRENT stage list verbatim (names/slugs/colors of stages between Qualified and Scheduled may differ from the illustrative list above). Preserve every existing stage; only insert `Engaged` and rename `Contacted`→`Following Up`, and renumber positions so they stay contiguous.

- [ ] **Step 2: Dry-run the SQL locally against a scratch DB (if available), else desk-check**

Run (only if a local supabase is linked): `supabase db query --linked --dry-run -f supabase/migrations/20260707120000_following_up_engaged_stages.sql` — otherwise re-read the file and confirm: (a) transaction wraps everything, (b) `engaged`/`nurturing` inserts are `where not exists` (idempotent), (c) backfill excludes `disqualified`/`lost`, (d) Engaged update runs BEFORE Nurturing (a replied-but-old lead is Engaged, not Nurturing — verify ordering gives Engaged precedence: the Engaged update moves those rows off `contacted_id` first, so the Nurturing update can't re-touch them). ✔

- [ ] **Step 3: Flag for the user to apply**

Do NOT apply migrations yourself. Leave a note in the PR/commit body: "Apply with `supabase db query --linked -f supabase/migrations/20260707120000_following_up_engaged_stages.sql` after review. Verify with the counts query below."

Verification query (for after apply):
```sql
select s.slug, s.name, count(l.id)
from pipeline_stages s
left join leads l on l.stage_id = s.id
where s.organization_id = (select id from organizations where slug = 'sf-dentistry')
  and s.slug in ('contacted','engaged','nurturing')
group by s.slug, s.name order by s.slug;
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260707120000_following_up_engaged_stages.sql
git commit -m "feat(db): Following Up rename + Engaged stage + backfill 23k contacted leads"
```

---

## Phase 4 — On-card Day-N badge

### Task 6: Cadence badge component

**Files:**
- Create: `src/components/crm/lead-cadence-badge.tsx`
- Modify: `src/lib/pipeline/stage-groups.ts` (add `ACTIVE_CONTACT_STAGE_SLUGS`)

- [ ] **Step 1: Add the helper the query will use**

Append to `src/lib/pipeline/stage-groups.ts`:

```ts
/** Stages whose cards show the Day-N cadence badge (the working funnel). */
export const ACTIVE_CONTACT_STAGE_SLUGS = ['contacted', 'engaged'] as const

const ACTIVE_CONTACT = new Set<string>(ACTIVE_CONTACT_STAGE_SLUGS)

/** True for the Following Up / Engaged stages that carry a cadence timeline. */
export function isActiveContactStage(slug: string | null | undefined): boolean {
  return !!slug && ACTIVE_CONTACT.has(slug)
}
```

- [ ] **Step 2: Create the badge component**

Create `src/components/crm/lead-cadence-badge.tsx`:

```tsx
'use client'

import { cadenceTimeline, type TimelineEnrollment } from '@/lib/pipeline/contacted-state'

function relative(nowMs: number, targetMs: number): string {
  const diff = targetMs - nowMs
  const day = 24 * 60 * 60 * 1000
  if (diff <= 0) return 'now'
  if (diff < day) return 'today'
  const days = Math.round(diff / day)
  return days === 1 ? 'in 1d' : `in ${days}d`
}

/**
 * The Day-N cadence badge for a Following Up / Engaged card:
 *   "DAY 6 · 4 of 8 · next: in 1d"  — or "REPLIED" when engaged,
 *   "NO REPLY · nurturing" when the cadence is exhausted.
 */
export function LeadCadenceBadge({
  enrollment,
  engaged,
  nowMs = Date.now(),
}: {
  enrollment: TimelineEnrollment | null
  engaged?: boolean
  nowMs?: number
}) {
  if (engaged) {
    return <span className="text-[10px] font-semibold rounded-full px-1.5 py-0.5 text-emerald-700 bg-emerald-500/15">REPLIED</span>
  }
  const tl = cadenceTimeline({ enrollment, now: nowMs })
  if (!tl) return null
  if (tl.exhausted) {
    return <span className="text-[10px] font-semibold rounded-full px-1.5 py-0.5 text-zinc-600 bg-black/[.06]">NO REPLY · nurturing</span>
  }
  const next = tl.nextTouchAtMs ? ` · next: ${relative(nowMs, tl.nextTouchAtMs)}` : ''
  return (
    <span className="text-[10px] font-semibold rounded-full px-1.5 py-0.5 text-amber-700 bg-amber-500/15">
      DAY {tl.dayN} · {tl.stepIndex + 1} of {tl.totalSteps}{next}
    </span>
  )
}
```

> Match the surrounding card's existing badge styling — inspect a current badge in `pipeline-board.tsx` (e.g. the `missing all upper` / score chips) and reuse the same class idiom (Tailwind + any Aurea tokens). The classes above are a starting point; align them with the real design system before finalizing.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/crm/lead-cadence-badge.tsx src/lib/pipeline/stage-groups.ts
git commit -m "feat(crm): Day-N cadence badge component"
```

### Task 7: Feed enrollment + timestamps into the board and mount the badge

**Files:**
- Modify: `src/app/(dashboard)/pipeline/page.tsx` (the per-stage `perStage` query, ≈56-94)
- Modify: `src/components/crm/pipeline-board.tsx` (the card render, ≈191-199) — or the lead-card subcomponent it delegates to

- [ ] **Step 1: Read the current card render + query**

Run: `sed -n '30,120p' 'src/app/(dashboard)/pipeline/page.tsx'` and `sed -n '160,230p' src/components/crm/pipeline-board.tsx`. Identify (a) how a stage's leads are selected, (b) the component that renders one card.

- [ ] **Step 2: Fetch the enrollment per lead for active-contact stages**

In `page.tsx`, after the `perStage` results are gathered, add a single batched query for the enrollments of the visible Following Up / Engaged leads and attach them. Insert after the `perStage` Promise.all (adapt variable names to the actual code):

```ts
import { isActiveContactStage } from '@/lib/pipeline/stage-groups'

// ... after perStage is built ...
const activeLeadIds = perStage
  .filter((p) => isActiveContactStage(allStages.find((s) => s.id === p.stageId)?.slug))
  .flatMap((p) => p.rows.map((r) => r.id))

const enrollmentByLead = new Map<string, { status: string; current_step: number; enrolled_at: string }>()
if (activeLeadIds.length > 0) {
  const { data: enrollments } = await supabase
    .from('follow_up_enrollments')
    .select('lead_id, status, current_step, enrolled_at')
    .eq('organization_id', orgId)
    .in('lead_id', activeLeadIds)
  for (const e of enrollments || []) enrollmentByLead.set(e.lead_id, e)
}
```

Pass `enrollmentByLead` (as a plain object `Object.fromEntries(enrollmentByLead)`) into `<PipelineBoard … enrollments={…} />`. The `leads` rows already include `last_contacted_at`, `last_responded_at`, `total_messages_received` because the query uses `select('*')` — confirm those columns are present; if `select` was narrowed, add them.

- [ ] **Step 3: Render the badge on the card**

In `pipeline-board.tsx`, thread the `enrollments` prop down to where a card renders, and mount the badge for active-contact stages:

```tsx
import { LeadCadenceBadge } from '@/components/crm/lead-cadence-badge'
import { classifyContactedState } from '@/lib/pipeline/contacted-state'
import { isActiveContactStage } from '@/lib/pipeline/stage-groups'

// inside the card render, where `lead` and `stage` are in scope:
{isActiveContactStage(stage.slug) && (
  <LeadCadenceBadge
    enrollment={enrollments?.[lead.id] ?? null}
    engaged={stage.slug === 'engaged' || classifyContactedState({
      last_contacted_at: lead.last_contacted_at,
      last_responded_at: lead.last_responded_at,
      total_messages_received: lead.total_messages_received,
    }, Date.now()) === 'engaged'}
  />
)}
```

- [ ] **Step 4: Verify in the running app**

Start the dev server via the preview tool (`preview_start`), open `/pipeline`, and confirm: the "Contacted" column header now reads **Following Up**, an **Engaged** column appears after it, and Following-Up cards show a `DAY n · x of 8` badge (or `NO REPLY · nurturing`). Use `preview_snapshot` to confirm the column titles and `preview_screenshot` to capture proof. Check `preview_console_logs` for errors.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/pipeline/page.tsx" src/components/crm/pipeline-board.tsx
git commit -m "feat(pipeline): show Following Up/Engaged columns with Day-N badge"
```

---

## Phase 5 — Auto-transitions (write stage_id, not just status)

### Task 8: Move the card on first contact and on reply

**Files:**
- Modify: `src/lib/ai/encounter-processor.ts:788-803` (the Status block)

- [ ] **Step 1: Read the surrounding function**

Run: `sed -n '740,860p' src/lib/ai/encounter-processor.ts`. Confirm `data.organizationId` (or equivalent), `data.leadId`, `data.channel`, `data.direction`/inbound flag, and the `supabase` client are in scope, and that `update` is the object written back to `leads` at the end.

- [ ] **Step 2: Add a stage-id resolver + set stage on transitions**

Replace the Status block (currently lines 788-798) with logic that ALSO moves `stage_id`. Add a small inline helper to resolve a slug → this org's stage id:

```ts
// Resolve a pipeline stage id by slug for this org (board grouping key).
async function stageIdForSlug(slug: string): Promise<string | null> {
  const { data } = await supabase
    .from('pipeline_stages')
    .select('id')
    .eq('organization_id', data_organizationId) // use the real org var in scope
    .eq('slug', slug)
    .maybeSingle()
  return data?.id ?? null
}

// Status + board stage
if (ext.appointmentBooked) {
  update.status = 'qualified'
  update.qualified_at = new Date().toISOString()
  const sid = await stageIdForSlug('qualified')
  if (sid) update.stage_id = sid
} else {
  // Did the patient send us anything inbound? → Engaged.
  const inbound =
    (data.channel === 'sms' || data.channel === 'email') && data.direction === 'inbound'
  if (inbound) {
    const sid = await stageIdForSlug('engaged')
    if (sid) update.stage_id = sid
    // keep status meaningful without inventing an enum value
    const { data: cur } = await supabase.from('leads').select('status,stage_id').eq('id', data.leadId).single()
    if (cur?.status === 'new') update.status = 'contacted'
  } else if (data.channel === 'voice' && (data.durationSeconds || 0) > 60) {
    update.status = 'contacted'
    const { data: cur } = await supabase.from('leads').select('stage_id').eq('id', data.leadId).single()
    const sid = await stageIdForSlug('contacted')
    // only advance a New lead onto Following Up; never pull a further lead back
    if (sid && (await isNewOrEarlier(cur?.stage_id))) update.stage_id = sid
  } else if (data.channel === 'sms' || data.channel === 'email') {
    const { data: cur } = await supabase.from('leads').select('status').eq('id', data.leadId).single()
    if (cur?.status === 'new') {
      update.status = 'contacted'
      const sid = await stageIdForSlug('contacted')
      if (sid) update.stage_id = sid
    }
  }
}
```

> Adapt `data_organizationId` and `data.direction` to the real field names in `EncounterData` (grep the type at the top of the file). If the processor has no inbound/outbound flag, derive "reply" from `data.channel` + the fact that the message was received (check how the SMS/email webhook calls `processEncounter` — inbound webhooks pass the patient's message). Do NOT guess: confirm the direction signal before writing.

- [ ] **Step 3: Guard against backward moves**

Implement `isNewOrEarlier(stageId)` as a tiny helper that returns true only when `stageId` maps to slug `new` or is null, so a >60s call never drags a lead who already replied (Engaged) back to Following Up. Use the reconcile `PRIORITY` map for the comparison if convenient, or a local slug lookup.

- [ ] **Step 4: Typecheck + run the full unit suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: zero TS errors; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/encounter-processor.ts
git commit -m "fix(ai): auto-move board stage on first contact (Following Up) and reply (Engaged)"
```

### Task 9: Exhausted cadence → Nurturing (in the follow-up cron)

**Files:**
- Modify: `src/app/api/cron/follow-up-sequences/route.ts`

- [ ] **Step 1: Read the cron**

Run: `sed -n '1,200p' src/app/api/cron/follow-up-sequences/route.ts`. Find where an enrollment is marked `completed` (after the last step) and where the lead is loaded.

- [ ] **Step 2: On completion with no reply, move the lead to Nurturing**

Where the enrollment transitions to `status='completed'`, add (adapting variable names): if the lead has NOT replied (`classifyContactedState(...) !== 'engaged'`) and is still on the `contacted` (Following Up) stage, set its `stage_id` to the org's `nurturing` stage. Reuse the classifier:

```ts
import { classifyContactedState } from '@/lib/pipeline/contacted-state'
// ... when marking an enrollment completed ...
const state = classifyContactedState({
  last_contacted_at: lead.last_contacted_at,
  last_responded_at: lead.last_responded_at,
  total_messages_received: lead.total_messages_received,
}, Date.now())
if (state !== 'engaged') {
  const { data: nurt } = await supabase
    .from('pipeline_stages').select('id')
    .eq('organization_id', lead.organization_id).eq('slug', 'nurturing').maybeSingle()
  const { data: contactedStage } = await supabase
    .from('pipeline_stages').select('id')
    .eq('organization_id', lead.organization_id).eq('slug', 'contacted').maybeSingle()
  if (nurt?.id && lead.stage_id === contactedStage?.id) {
    await supabase.from('leads').update({ stage_id: nurt.id }).eq('id', lead.id)
  }
}
```

This is a stage move only — it fires no messages and is unaffected by `MESSAGING_DRY_RUN`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/cron/follow-up-sequences/route.ts
git commit -m "feat(cron): drop exhausted no-reply leads from Following Up to Nurturing"
```

---

## Final verification

- [ ] `npx tsc --noEmit` clean (type errors block the Vercel build — see the "type-errors-block-vercel" project note).
- [ ] `npx vitest run` all green.
- [ ] Dev server: `/pipeline` shows **Following Up** + **Engaged** columns, badges render, drag-drop still works (writes `stage_id`).
- [ ] Migration file present but NOT applied — call it out explicitly in the PR body with the apply command and the verification counts query.
- [ ] Confirm nothing in this change lifts the messaging hard-stop: grep the diff for any `sendSms`/`sendEmail`/Twilio/Resend call — there should be none. Board + stage moves only.

## Out of scope (do NOT do here)

- Enrolling the 23k existing leads into live cadence (that's the send switch; separate task, gated by `MESSAGING_DRY_RUN`).
- Changing the `leads.status` CHECK enum. Engaged is a stage, not a status.
- Touching the day-7→60 re-engagement ladder (`src/lib/nurture/ladder.ts`) beyond the exhaust→Nurturing hop.

## Self-review notes (author checklist — completed)

- **Spec coverage:** Following Up rename (Task 5) ✓; Engaged stage (Tasks 3-5) ✓; on-card Day-N timeline (Tasks 2,6,7) ✓; auto-exits reply→Engaged & first-contact→Following Up (Task 8) ✓; exhaust→Nurturing (Task 9) ✓; GHL map-only/no explosion (Tasks 3-4, slug reuse in Task 5) ✓; read-only backfill (Task 5) ✓; send-safety (final verification) ✓.
- **Type consistency:** `classifyContactedState`, `cadenceTimeline`, `ContactSignals`, `TimelineEnrollment`, `ENGAGED_MAX_CADENCE_DAYS`, `isActiveContactStage`, `ACTIVE_CONTACT_STAGE_SLUGS`, `LeadCadenceBadge`, `PRIORITY`, `NATIVE` — names are used identically across tasks.
- **Known adaptation points flagged inline:** exact org/direction field names in the encounter processor; the real current seed stage list; the real card badge styling. Each is called out as "confirm before editing" rather than guessed.
