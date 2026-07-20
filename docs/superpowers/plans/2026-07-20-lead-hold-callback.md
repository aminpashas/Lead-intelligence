# Lead Hold + Callback Plan — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a rep put a lead on hold until a chosen date so all outbound automation skips it until then, paired with a dated callback task that surfaces on `/tasks`.

**Architecture:** Four columns on `leads` (`hold_until`, `hold_reason`, `hold_set_by`, `hold_set_at`) hold the state. One `src/lib/leads/hold.ts` module is the single choke point every outbound path calls, so the "on hold" predicate lives in one place instead of being duplicated. Setting a hold mints one `human_tasks` row of new kind `callback` whose `due_at` is the hold date. The existing `task-sweep` cron clears expired holds. No new cron, no new reminders table.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Supabase (Postgres + RLS), Vitest, Tailwind/shadcn UI. Reference spec: `docs/superpowers/specs/2026-07-20-lead-hold-callback-design.md`.

**Branch note:** Work off `main` on a fresh branch (`lead-hold-callback`). Do NOT build on `dion-sso-receiver` — it carries unrelated uncommitted social-window work. Do not touch those files.

---

## File Structure

| File | Responsibility | Create/Modify |
| --- | --- | --- |
| `supabase/migrations/20260720170000_leads_hold.sql` | `leads` hold columns + partial index | Create |
| `supabase/migrations/20260720170100_human_tasks_callback.sql` | add `callback` kind (full replay) | Create |
| `src/types/database.ts` | `Lead` type gains hold fields; `SmartListCriteria` gains `exclude_on_hold` | Modify |
| `src/lib/leads/hold.ts` | the choke point: `isOnHold`, `applyNotOnHold`, `HOLD_SELECT_COLUMNS` | Create |
| `src/lib/leads/hold.test.ts` | unit tests for the module | Create |
| `src/lib/voice/call-manager.ts` | `preCallCheck` gains an on-hold gate | Modify |
| `src/lib/voice/call-manager.test.ts` | test the new gate | Create (or append) |
| `src/lib/consent/gate.ts` | `ConsentDenyReason` gains `'on_hold'`; `assertConsent` checks it | Modify |
| `src/lib/voice/dialer-queue.ts` | dialer queue excludes held leads | Modify |
| `src/lib/voice/campaign-dialer.ts` | campaign dialer enrollment excludes held leads | Modify |
| `src/lib/campaigns/smart-list-resolver.ts` | `applyCriteria` excludes held leads | Modify |
| `src/lib/campaigns/eligibility.ts` | `on_hold` bucket in the tally | Modify |
| `src/lib/campaigns/eligibility.test.ts` | test the new bucket | Create (or append) |
| `src/lib/automation/tasks.ts` | `HumanTaskKind` gains `callback`; `taskDedupeKeyForHold` | Modify |
| `src/lib/automation/hold-tasks.ts` | `setLeadHold` / `clearLeadHold` orchestration | Create |
| `src/lib/automation/hold-tasks.test.ts` | tests | Create |
| `src/lib/automation/task-sweep.ts` | `expireHolds` step called from `sweepOrg` | Modify |
| `src/app/api/leads/[id]/hold/route.ts` | PUT (set) / DELETE (clear) endpoint | Create |
| `src/app/api/tasks/route.ts` | `callback` added to `VALID_KINDS` | Modify |
| `src/components/crm/hold-lead.tsx` | the Hold dialog control | Create |
| `src/components/crm/lead-actions.tsx` | render `HoldLead` next to `MarkDeliberating` | Modify |
| `src/components/crm/hold-badge.tsx` | "On hold until …" badge | Create |

---

## Task 1: Migration — `leads` hold columns

**Files:**
- Create: `supabase/migrations/20260720170000_leads_hold.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Lead hold: a dated pause on ALL outbound automation for one lead.
-- hold_until IS NULL  → not on hold. A hold is cleared (not just expired) by
-- task-sweep once the date passes, so every consumer checks the same simple
-- predicate: hold_until IS NULL OR hold_until < now().
--
-- Distinct from closing_follow_up_at (20260708130000), which only mutes the
-- /closing board for deliberating deals. This actually silences the dialer,
-- campaigns, and sequences, and works on a brand-new lead. Idempotent.
DO $$
BEGIN
  IF to_regclass('public.leads') IS NOT NULL THEN
    ALTER TABLE public.leads
      ADD COLUMN IF NOT EXISTS hold_until  timestamptz,
      ADD COLUMN IF NOT EXISTS hold_reason text,
      ADD COLUMN IF NOT EXISTS hold_set_by uuid REFERENCES auth.users(id),
      ADD COLUMN IF NOT EXISTS hold_set_at timestamptz;

    CREATE INDEX IF NOT EXISTS idx_leads_hold_until
      ON public.leads (organization_id, hold_until)
      WHERE hold_until IS NOT NULL;
  END IF;
END $$;
```

- [ ] **Step 2: Verify it applies against a scratch branch**

Run: `npx supabase db lint --schema public` (syntax check) if the CLI is wired; otherwise eyeball the DO-block guard matches the pattern in `20260716140000_human_tasks_follow_up.sql`.
Expected: no syntax error.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260720170000_leads_hold.sql
git commit -m "feat(db): add lead hold columns + partial index"
```

---

## Task 2: Migration — `human_tasks` gains `callback` kind

**Files:**
- Create: `supabase/migrations/20260720170100_human_tasks_callback.sql`

⚠️ Per `20260716140000_human_tasks_follow_up.sql:9-13`, this constraint is dropped and recreated with a full hardcoded list every time. You MUST replay all ten existing kinds plus `callback`, in order, or you silently drop whichever you omit.

- [ ] **Step 1: Write the migration**

```sql
-- human_tasks.kind += 'callback' (lead hold).
--
-- Setting a hold on a lead mints exactly one live 'callback' task whose due_at
-- is the hold date — the "active plan" the rep sees on /tasks. A dedicated kind
-- keeps it from deduping onto the allocation engine's or the sweep's rows.
--
-- CONSTRAINT REPLAY: every migration touching human_tasks_kind_check recreates
-- the FULL list. This carries every kind added before 'callback'. Do not trim.
-- Guarded + idempotent.
DO $$
BEGIN
  IF to_regclass('public.human_tasks') IS NOT NULL THEN
    ALTER TABLE public.human_tasks DROP CONSTRAINT IF EXISTS human_tasks_kind_check;
    ALTER TABLE public.human_tasks ADD CONSTRAINT human_tasks_kind_check CHECK (kind IN (
      'inbound_reply', 'first_touch', 'nurture_step', 'stage_automation',
      'recommendation', 'sla_breach_review', 'call_review', 'list_call', 'manual',
      'follow_up', 'callback'
    ));
  END IF;
END $$;
```

- [ ] **Step 2: Verify the list is complete**

Run: `grep -o "'[a-z_]*'" supabase/migrations/20260720170100_human_tasks_callback.sql | sort`
Expected: exactly these 11 — `callback, call_review, first_touch, follow_up, inbound_reply, list_call, manual, nurture_step, recommendation, sla_breach_review, stage_automation`. If any from `20260716140000` is missing, add it.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260720170100_human_tasks_callback.sql
git commit -m "feat(db): add human_tasks 'callback' kind for lead holds"
```

---

## Task 3: Types — `Lead` hold fields + `HumanTaskKind`

**Files:**
- Modify: `src/types/database.ts` (near `closing_follow_up_at`, line ~287)
- Modify: `src/lib/automation/tasks.ts:39` (the `HumanTaskKind` union)

- [ ] **Step 1: Add the hold fields to the `Lead` type**

In `src/types/database.ts`, immediately after the `closing_follow_up_at: string | null` line (~287):

```typescript
  // Lead hold: a dated pause on all outbound automation. null = not on hold.
  // See src/lib/leads/hold.ts. Distinct from closing_follow_up_at above.
  hold_until: string | null
  hold_reason: string | null
  hold_set_by: string | null
  hold_set_at: string | null
```

- [ ] **Step 2: Add `callback` to `HumanTaskKind`**

In `src/lib/automation/tasks.ts`, after the `'follow_up'` member (:39):

```typescript
  // A dated callback the rep committed to; minted when a lead is put on hold.
  // due_at is the hold date. See src/lib/automation/hold-tasks.ts.
  | 'callback'
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no NEW errors referencing `hold_until` or `callback`. (Pre-existing unrelated errors may exist — compare against a baseline `git stash`/`tsc` if unsure.)

- [ ] **Step 4: Commit**

```bash
git add src/types/database.ts src/lib/automation/tasks.ts
git commit -m "feat(types): lead hold fields + callback task kind"
```

---

## Task 4: The choke point — `src/lib/leads/hold.ts`

**Files:**
- Create: `src/lib/leads/hold.ts`
- Test: `src/lib/leads/hold.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/leads/hold.test.ts
import { describe, it, expect } from 'vitest'
import { isOnHold } from './hold'

describe('isOnHold', () => {
  const now = new Date('2026-07-20T12:00:00Z')

  it('is false when hold_until is null', () => {
    expect(isOnHold({ hold_until: null }, now)).toBe(false)
  })

  it('is true when hold_until is in the future', () => {
    expect(isOnHold({ hold_until: '2026-07-25T12:00:00Z' }, now)).toBe(true)
  })

  it('is false when hold_until is in the past', () => {
    expect(isOnHold({ hold_until: '2026-07-19T12:00:00Z' }, now)).toBe(false)
  })

  it('is false at exactly now (boundary — hold has just expired)', () => {
    expect(isOnHold({ hold_until: '2026-07-20T12:00:00Z' }, now)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/leads/hold.test.ts`
Expected: FAIL — `Cannot find module './hold'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/leads/hold.ts
/**
 * Lead hold — the single choke point for "is this lead paused right now?".
 *
 * A hold suppresses ALL outbound AUTOMATION until hold_until passes. It never
 * blocks a human-initiated action (the UI warns and lets the rep override) and
 * never suppresses inbound. Every outbound path routes through this module so
 * the predicate lives in exactly one place — see the spec's "choke point".
 *
 * The rule is deliberately trivial — hold_until IS NULL OR hold_until < now —
 * because task-sweep CLEARS an expired hold's column rather than leaving a stale
 * past date. So a non-null hold_until in the future is the only "on hold" state.
 */
import type { PostgrestFilterBuilder } from '@supabase/postgrest-js'

/** The columns any query must select for isOnHold() to work. Spread into selects. */
export const HOLD_SELECT_COLUMNS = 'hold_until' as const

export type HoldableLead = { hold_until: string | null }

/** True when the lead is on hold at `now` (defaults to the current time). */
export function isOnHold(lead: HoldableLead, now: Date = new Date()): boolean {
  if (!lead.hold_until) return false
  return new Date(lead.hold_until).getTime() > now.getTime()
}

/**
 * Add the "not currently on hold" filter to a PostgREST leads query: keeps rows
 * whose hold_until is null OR already in the past. Mirrors the null-inclusive
 * .or() pattern used by last_contacted_before in smart-list-resolver.
 */
export function applyNotOnHold<T extends PostgrestFilterBuilder<any, any, any>>(
  query: T,
  now: Date = new Date(),
): T {
  return query.or(`hold_until.is.null,hold_until.lt.${now.toISOString()}`) as T
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/leads/hold.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/leads/hold.ts src/lib/leads/hold.test.ts
git commit -m "feat(leads): hold choke-point module (isOnHold / applyNotOnHold)"
```

---

## Task 5: Wire the dialer queue

**Files:**
- Modify: `src/lib/voice/dialer-queue.ts:32` (select) and `:107` (filter)

- [ ] **Step 1: Add the hold column to `DIALER_SELECT`**

At `src/lib/voice/dialer-queue.ts:32`, append `hold_until` to the select string:

```typescript
const DIALER_SELECT =
  'id, first_name, last_name, phone, phone_formatted, ai_score, ai_qualification, status, last_contacted_at, city, state, ai_summary, conversation_summary, hold_until'
```

- [ ] **Step 2: Apply the filter**

At `src/lib/voice/dialer-queue.ts`, add the import at the top:

```typescript
import { applyNotOnHold } from '@/lib/leads/hold'
```

Then, immediately after the `.not('status', 'in', '(lost,disqualified,completed)')` line (:107):

```typescript
    .not('status', 'in', '(lost,disqualified,completed)')
  // Held leads are paused from the dialer until their hold_until passes.
  query = applyNotOnHold(query)
```

(Note: the existing chain assigns to `let query`. Break the fluent chain after the `.not(...)` and reassign — `query = applyNotOnHold(query)` — exactly as the `excludeRecentlyContacted` block below already does.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/voice/dialer-queue.ts
git commit -m "feat(dialer): exclude held leads from the power-dialer queue"
```

---

## Task 6: Wire the campaign dialer enrollment

**Files:**
- Modify: `src/lib/voice/campaign-dialer.ts:~264` (after the `.not('phone_formatted', 'is', null)` line)

- [ ] **Step 1: Apply the filter**

Add the import at the top of `src/lib/voice/campaign-dialer.ts`:

```typescript
import { applyNotOnHold } from '@/lib/leads/hold'
```

After the `.not('phone_formatted', 'is', null)` line in the `let query = supabase.from('leads')…` chain:

```typescript
    .not('phone_formatted', 'is', null)
  // Held leads are excluded from campaign auto-enrollment too (spec choke point).
  query = applyNotOnHold(query)
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/voice/campaign-dialer.ts
git commit -m "feat(dialer): exclude held leads from campaign enrollment"
```

---

## Task 7: Wire the consent gate

**Files:**
- Modify: `src/lib/consent/gate.ts` — `ConsentDenyReason` (:32-37), `ConsentLeadFields` (:39-53), `CONSENT_FIELDS` (:55-68), `assertConsent` (:76-107)

- [ ] **Step 1: Add the deny reason and field**

In `src/lib/consent/gate.ts`, extend `ConsentDenyReason` (:37) with:

```typescript
  | 'on_hold'
```

Add to `ConsentLeadFields` (after `voice_consent_status`, :52):

```typescript
  hold_until: string | null
```

Add `'hold_until'` to the `CONSENT_FIELDS` array (:64, after `'do_not_call'`).

- [ ] **Step 2: Add the check in `assertConsent`**

In `assertConsent`, right after the `if (error || !lead)` guard (:89) and before the `switch (channel)`:

```typescript
  // A lead on hold is paused on EVERY channel for automation. This is the gate
  // for automation callers; human sends bypass the gate entirely (see callers).
  if (lead.hold_until && new Date(lead.hold_until).getTime() > Date.now()) {
    return { allowed: false, reason: 'on_hold', lead }
  }
```

(Use the inline check rather than `isOnHold` to avoid importing a client-typed module into the gate; the predicate is identical.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors. If a caller does an exhaustive `switch` over `ConsentDenyReason`, add an `'on_hold'` arm there (search: `grep -rn "reason ===" src | grep -i consent`).

- [ ] **Step 4: Commit**

```bash
git add src/lib/consent/gate.ts
git commit -m "feat(consent): deny automation sends to leads on hold"
```

---

## Task 8: Wire smart-list resolver + eligibility bucket

**Files:**
- Modify: `src/types/database.ts` — `SmartListCriteria` (~:1108, near `closing_temperatures`)
- Modify: `src/lib/campaigns/smart-list-resolver.ts:~229` (end of `applyCriteria`)
- Modify: `src/lib/campaigns/eligibility.ts`
- Test: `src/lib/campaigns/eligibility.test.ts`

- [ ] **Step 1: Default smart lists to exclude held leads**

In `src/lib/campaigns/smart-list-resolver.ts`, add the import:

```typescript
import { applyNotOnHold } from '@/lib/leads/hold'
```

At the end of `applyCriteria`, immediately before `return query` (:231):

```typescript
  // Held leads are excluded from every smart-list audience by default — a smart
  // list is an automation audience, and a hold pauses automation.
  query = applyNotOnHold(query)

  return query
```

(If `applyCriteria` builds `query` as a parameter rather than a `let`, reassign the parameter — it is a local binding.)

- [ ] **Step 2: Write the failing eligibility test**

```typescript
// src/lib/campaigns/eligibility.test.ts
import { describe, it, expect } from 'vitest'
import { computeEligibility } from './eligibility'

describe('computeEligibility on_hold bucket', () => {
  it('counts a held lead as on_hold, not eligible', () => {
    const future = '2999-01-01T00:00:00Z'
    const out = computeEligibility(
      [{ sms_opt_out: false, phone_formatted: 'x', hold_until: future }],
      'sms',
    )
    expect(out.eligible).toBe(0)
    expect(out.on_hold).toBe(1)
  })

  it('buckets still sum to total - eligible', () => {
    const future = '2999-01-01T00:00:00Z'
    const leads = [
      { sms_opt_out: false, phone_formatted: 'x', hold_until: null },     // eligible
      { sms_opt_out: true, phone_formatted: 'x', hold_until: null },      // opted_out
      { sms_opt_out: false, phone_formatted: null, hold_until: null },    // no_contact
      { sms_opt_out: false, phone_formatted: 'x', hold_until: future },   // on_hold
    ]
    const out = computeEligibility(leads, 'sms')
    expect(out.on_hold + out.opted_out + out.no_contact + out.no_consent)
      .toBe(out.total - out.eligible)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/lib/campaigns/eligibility.test.ts`
Expected: FAIL — `on_hold` is not a property of the result.

- [ ] **Step 4: Add the bucket**

In `src/lib/campaigns/eligibility.ts`:

Add `hold_until?: string | null` to `LeadConsentRow` (after `email?`).

Add `on_hold: number` to the `ChannelEligibility` type and to the `out` initializer (`on_hold: 0`).

Replace the classification loop body so on_hold is checked FIRST (highest priority, keeps the buckets mutually exclusive):

```typescript
  for (const l of leads) {
    const onHold = !!l.hold_until && new Date(l.hold_until).getTime() > Date.now()
    const optedOut = channel === 'sms' ? l.sms_opt_out === true : l.email_opt_out === true
    const hasContact = channel === 'sms' ? !!l.phone_formatted : !!l.email

    if (onHold) {
      out.on_hold++
    } else if (!optedOut && hasContact) {
      out.eligible++
    } else if (optedOut) {
      out.opted_out++
    } else {
      out.no_contact++
    }
  }
```

Update the doc comment at the top: buckets are now `on_hold > opted_out > no_contact` in priority order and still sum to `total - eligible`.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/lib/campaigns/eligibility.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit` — fix any callers that destructure `ChannelEligibility` exhaustively.

```bash
git add src/types/database.ts src/lib/campaigns/smart-list-resolver.ts src/lib/campaigns/eligibility.ts src/lib/campaigns/eligibility.test.ts
git commit -m "feat(campaigns): exclude held leads from audiences + on_hold tally bucket"
```

---

## Task 9: Wire send-authorization

**Files:**
- Modify: `src/lib/campaigns/send-authorization.ts`

- [ ] **Step 1: Deny automation sends for held leads**

In `assertCampaignSendAllowed`, extend the `CampaignSendDecision` reason union (:14) with `'on_hold'`:

```typescript
  | { allowed: false; reason: 'no_active_campaign' | 'send_suppressed' | 'on_hold' }
```

Then, inside the function, change the lead select to include `hold_until` and check it (this runs only for automation callers, since the human short-circuit `if (!isAutomationCaller(...)) return { allowed: true }` at :25 is already above):

```typescript
  const { data: lead } = await supabase
    .from('leads')
    .select('organization_id, hold_until')
    .eq('id', params.leadId)
    .single()
  if (!lead) return { allowed: false, reason: 'no_active_campaign' }

  const holdUntil = (lead as any).hold_until as string | null
  if (holdUntil && new Date(holdUntil).getTime() > Date.now()) {
    return { allowed: false, reason: 'on_hold' }
  }
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/campaigns/send-authorization.ts
git commit -m "feat(campaigns): send-authorization denies automation sends to held leads"
```

---

## Task 10: Pre-call gate

**Files:**
- Modify: `src/lib/voice/call-manager.ts` — select (:66-72), gate (~:91)
- Test: `src/lib/voice/call-manager.test.ts`

The `PreCallCheckResult` reason is a string union; find it (search `type PreCallCheckResult` / `reason:` near the top of the file) and add `'on_hold'`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/voice/call-manager.test.ts
import { describe, it, expect, vi } from 'vitest'
import { preCallCheck } from './call-manager'

/** Minimal chainable stub returning a single lead row from .single(). */
function stubClientWithLead(lead: Record<string, unknown>) {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    single: () => Promise.resolve({ data: lead, error: null }),
  }
  return { from: () => chain } as any
}

describe('preCallCheck hold gate', () => {
  it('denies with on_hold when the lead is held into the future', async () => {
    const client = stubClientWithLead({
      id: 'l1', first_name: 'A', phone_formatted: null, phone: '+15551234567',
      voice_opt_out: false, do_not_call: false,
      hold_until: '2999-01-01T00:00:00Z', timezone: 'America/New_York',
    })
    const res = await preCallCheck(client, 'l1', 'org1')
    expect(res.allowed).toBe(false)
    expect((res as any).reason).toBe('on_hold')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/voice/call-manager.test.ts`
Expected: FAIL — currently returns `allowed: true` or a different reason (hold not checked).

- [ ] **Step 3: Add `hold_until` to the select and the gate**

In the select at `call-manager.ts:66-72`, add `hold_until` to the column list (e.g. after `do_not_call,`).

Add the gate immediately after the `voice_opt_out` check (after :91), before the TCPA window:

```typescript
  // Lead on hold: automation and speed-to-lead calls are paused until the hold
  // date. A staff dial from the softphone can still override — that path warns
  // in the UI and does not call preCallCheck for the hold decision.
  if (lead.hold_until && new Date(lead.hold_until).getTime() > Date.now()) {
    return { allowed: false, reason: 'on_hold' }
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/voice/call-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit`

```bash
git add src/lib/voice/call-manager.ts src/lib/voice/call-manager.test.ts
git commit -m "feat(voice): preCallCheck pauses automated calls to held leads"
```

---

## Task 11: Hold orchestration — set / clear + callback task

**Files:**
- Modify: `src/lib/automation/tasks.ts` — add `taskDedupeKeyForHold` near the other dedupe builders (:171)
- Create: `src/lib/automation/hold-tasks.ts`
- Test: `src/lib/automation/hold-tasks.test.ts`

- [ ] **Step 1: Add the dedupe-key builder**

In `src/lib/automation/tasks.ts`, after `taskDedupeKeyForListCall` (:171):

```typescript
/** One live callback task per held lead. Cleared when the hold is cleared/expires. */
export function taskDedupeKeyForHold(leadId: string): string {
  return `hold:${leadId}`
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// src/lib/automation/hold-tasks.test.ts
import { describe, it, expect } from 'vitest'
import { buildHoldTaskInput } from './hold-tasks'

describe('buildHoldTaskInput', () => {
  it('produces a callback task with due_at = hold date and the hold dedupe key', () => {
    const input = buildHoldTaskInput({
      organizationId: 'org1',
      leadId: 'lead1',
      leadName: 'Jane D.',
      holdUntil: '2026-08-03T16:00:00Z',
      reason: 'wants to talk to spouse',
      assignedTo: 'user1',
      assignedRole: 'office_manager',
      createdBy: 'user1',
    })
    expect(input.kind).toBe('callback')
    expect(input.due_at).toBe('2026-08-03T16:00:00Z')
    expect(input.dedupe_key).toBe('hold:lead1')
    expect(input.detail).toContain('spouse')
    expect(input.title).toContain('Jane D.')
    expect(input.source).toBe('lead_hold')
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/lib/automation/hold-tasks.test.ts`
Expected: FAIL — `Cannot find module './hold-tasks'`.

- [ ] **Step 4: Implement `hold-tasks.ts`**

```typescript
// src/lib/automation/hold-tasks.ts
/**
 * Lead hold orchestration: set / clear the hold on a lead and keep its single
 * live 'callback' task in sync. The task IS the "plan" — it carries the callback
 * date (due_at) and surfaces on /tasks. One hold ⇒ one live callback task,
 * enforced by the hold dedupe key + the human_tasks partial unique index.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import {
  createHumanTask,
  resolveAssignee,
  taskDedupeKeyForHold,
  type CreateHumanTaskInput,
} from './tasks'

export type SetHoldParams = {
  organizationId: string
  leadId: string
  leadName: string
  holdUntil: string // ISO
  reason: string | null
  userId: string // the staff user setting the hold
}

/** Pure builder (unit-tested): the callback task for a hold. */
export function buildHoldTaskInput(params: {
  organizationId: string
  leadId: string
  leadName: string
  holdUntil: string
  reason: string | null
  assignedTo: string | null
  assignedRole: string | null
  createdBy: string
}): CreateHumanTaskInput {
  const when = new Date(params.holdUntil).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric',
  })
  return {
    organization_id: params.organizationId,
    lead_id: params.leadId,
    kind: 'callback',
    title: `Call back ${params.leadName} (on hold until ${when})`,
    detail: params.reason || null,
    due_at: params.holdUntil,
    assigned_to: params.assignedTo,
    assigned_role: params.assignedRole,
    dedupe_key: taskDedupeKeyForHold(params.leadId),
    source: 'lead_hold',
    created_by: params.createdBy,
    metadata: { hold_until: params.holdUntil },
  }
}

/** Set (or update) a hold on a lead, minting/refreshing its callback task. */
export async function setLeadHold(
  supabase: SupabaseClient,
  params: SetHoldParams,
): Promise<{ ok: boolean; taskId: string | null }> {
  const nowIso = new Date().toISOString()
  const { error: updErr } = await supabase
    .from('leads')
    .update({
      hold_until: params.holdUntil,
      hold_reason: params.reason,
      hold_set_by: params.userId,
      hold_set_at: nowIso,
    })
    .eq('id', params.leadId)
    .eq('organization_id', params.organizationId)

  if (updErr) {
    logger.warn('LeadHold: failed to set hold', { leadId: params.leadId, error: updErr.message })
    return { ok: false, taskId: null }
  }

  const assignee = await resolveAssignee(supabase, params.organizationId, params.leadId)
  const { taskId } = await createHumanTask(
    supabase,
    buildHoldTaskInput({
      organizationId: params.organizationId,
      leadId: params.leadId,
      leadName: params.leadName,
      holdUntil: params.holdUntil,
      reason: params.reason,
      assignedTo: assignee.userId,
      assignedRole: assignee.role,
      createdBy: params.userId,
    }),
  )

  await supabase.from('lead_activities').insert({
    organization_id: params.organizationId,
    lead_id: params.leadId,
    activity_type: 'hold_set',
    title: `On hold until ${new Date(params.holdUntil).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
    metadata: { hold_until: params.holdUntil, reason: params.reason, actor_user_id: params.userId },
  })

  return { ok: true, taskId }
}

/**
 * Clear a hold (manual clear or expiry). Nulls the columns and completes the
 * live callback task. `reason` distinguishes a manual clear from expiry for the
 * activity log. Returns whether the lead row was actually cleared.
 */
export async function clearLeadHold(
  supabase: SupabaseClient,
  params: { organizationId: string; leadId: string; via: 'manual' | 'expiry'; userId?: string },
): Promise<{ ok: boolean }> {
  const { error } = await supabase
    .from('leads')
    .update({ hold_until: null, hold_reason: null, hold_set_by: null, hold_set_at: null })
    .eq('id', params.leadId)
    .eq('organization_id', params.organizationId)

  if (error) {
    logger.warn('LeadHold: failed to clear hold', { leadId: params.leadId, error: error.message })
    return { ok: false }
  }

  // Complete the live callback task (it has served its purpose once the hold ends).
  await supabase
    .from('human_tasks')
    .update({ status: 'done', completed_at: new Date().toISOString() })
    .eq('organization_id', params.organizationId)
    .eq('dedupe_key', taskDedupeKeyForHold(params.leadId))
    .in('status', ['open', 'claimed'])

  await supabase.from('lead_activities').insert({
    organization_id: params.organizationId,
    lead_id: params.leadId,
    activity_type: 'hold_cleared',
    title: params.via === 'expiry' ? 'Hold expired' : 'Hold cleared',
    metadata: { via: params.via, ...(params.userId ? { actor_user_id: params.userId } : {}) },
  })

  return { ok: true }
}
```

> Note: `activity_type` values `hold_set` / `hold_cleared` need NO constraint migration — `lead_activities_activity_type_check` is a regex (`^[a-z][a-z0-9_]*$`, see `20260702134500`).

- [ ] **Step 5: Run to verify the builder test passes**

Run: `npx vitest run src/lib/automation/hold-tasks.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit`

```bash
git add src/lib/automation/tasks.ts src/lib/automation/hold-tasks.ts src/lib/automation/hold-tasks.test.ts
git commit -m "feat(leads): set/clear lead hold + callback task orchestration"
```

---

## Task 12: Expiry in the task sweep

**Files:**
- Modify: `src/lib/automation/task-sweep.ts` — new `expireHolds`, called from `sweepOrg` (:345)

- [ ] **Step 1: Add `expireHolds` and call it from `sweepOrg`**

Add the import at the top of `task-sweep.ts`:

```typescript
import { clearLeadHold } from './hold-tasks'
```

Add this function above `sweepOrg`:

```typescript
/**
 * Clear holds whose date has passed: null the columns and complete the callback
 * task. Runs inside the 15-min sweep — no dedicated cron. Capped like the rules.
 */
async function expireHolds(supabase: SupabaseClient, orgId: string): Promise<number> {
  const nowIso = new Date().toISOString()
  const { data: expired } = await supabase
    .from('leads')
    .select('id')
    .eq('organization_id', orgId)
    .not('hold_until', 'is', null)
    .lt('hold_until', nowIso)
    .limit(PER_RULE_CAP)

  let cleared = 0
  for (const row of expired ?? []) {
    const { ok } = await clearLeadHold(supabase, {
      organizationId: orgId,
      leadId: (row as { id: string }).id,
      via: 'expiry',
    })
    if (ok) cleared++
  }
  return cleared
}
```

In `sweepOrg`, after the `for (const rule of SWEEP_RULES)` loop and before `return total` (:361):

```typescript
  try {
    const clearedHolds = await expireHolds(supabase, orgId)
    total.closed += clearedHolds
  } catch (err) {
    logger.warn('TaskSweep: expireHolds threw', {
      orgId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors. (If `SweepResult` has no `closed` field, use the existing counter names — confirm with `grep -n "type SweepResult" src/lib/automation/task-sweep.ts`.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/automation/task-sweep.ts
git commit -m "feat(cron): task-sweep clears expired lead holds"
```

---

## Task 13: API route — set / clear hold

**Files:**
- Create: `src/app/api/leads/[id]/hold/route.ts`
- Modify: `src/app/api/tasks/route.ts:30` — add `'callback'` to `VALID_KINDS`

Model the auth + org-scoping + `params` await on the sibling `src/app/api/leads/[id]/closing/route.ts`. Read it first and copy its `createClient()` usage, its `await params`, and its org-membership pattern verbatim — do not invent a new auth shape.

- [ ] **Step 1: Add `callback` to the tasks list filter**

In `src/app/api/tasks/route.ts`, add `'callback'` to the `VALID_KINDS` array (:30-41) so callback tasks are listable/filterable on `/tasks`.

- [ ] **Step 2: Write the route**

```typescript
// src/app/api/leads/[id]/hold/route.ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { setLeadHold, clearLeadHold } from '@/lib/automation/hold-tasks'
import { leadDisplayName } from '@/lib/leads/display-name'

const putSchema = z.object({
  holdUntil: z.string().datetime(),
  reason: z.string().trim().max(500).nullable().optional(),
})

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const parsed = putSchema.safeParse(await req.json())
  if (!parsed.success) return NextResponse.json({ error: 'bad_request' }, { status: 400 })

  // Org scope + name come from the lead the caller can see under RLS.
  const { data: lead } = await supabase
    .from('leads')
    .select('id, organization_id, first_name, last_name')
    .eq('id', id)
    .single()
  if (!lead) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  // Guard: hold must be in the future.
  if (new Date(parsed.data.holdUntil).getTime() <= Date.now()) {
    return NextResponse.json({ error: 'hold_must_be_future' }, { status: 400 })
  }

  const res = await setLeadHold(supabase, {
    organizationId: (lead as any).organization_id,
    leadId: id,
    leadName: leadDisplayName(lead as any),
    holdUntil: parsed.data.holdUntil,
    reason: parsed.data.reason ?? null,
    userId: auth.user.id,
  })
  if (!res.ok) return NextResponse.json({ error: 'update_failed' }, { status: 500 })
  return NextResponse.json({ ok: true, taskId: res.taskId })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: lead } = await supabase
    .from('leads').select('organization_id').eq('id', id).single()
  if (!lead) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const res = await clearLeadHold(supabase, {
    organizationId: (lead as any).organization_id,
    leadId: id,
    via: 'manual',
    userId: auth.user.id,
  })
  if (!res.ok) return NextResponse.json({ error: 'update_failed' }, { status: 500 })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 3: Verify `leadDisplayName` accepts this shape**

Run: `grep -n "export function leadDisplayName" src/lib/leads/display-name.ts`
Expected: a function taking `{ first_name, last_name }`-ish. If its signature differs, pass the fields it wants.

- [ ] **Step 4: Typecheck + commit**

Run: `npx tsc --noEmit`

```bash
git add src/app/api/leads/[id]/hold/route.ts src/app/api/tasks/route.ts
git commit -m "feat(api): PUT/DELETE lead hold endpoint + list callback tasks"
```

---

## Task 14: UI — Hold dialog control

**Files:**
- Create: `src/components/crm/hold-lead.tsx`

Modeled directly on `src/components/crm/mark-deliberating.tsx` — reuse its `dateInputValue` helper and its noon-local normalization (`new Date(\`${date}T12:00:00\`).toISOString()`, :77) to avoid a UTC day-shift.

- [ ] **Step 1: Write the component**

```tsx
'use client'

/**
 * HoldLead — put a lead on hold until a date. Suppresses ALL outbound
 * automation until then (dialer, campaigns, sequences); mints a dated callback
 * task on /tasks. Clearing removes the hold and completes that task.
 * PUT/DELETE /api/leads/[id]/hold.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PauseCircle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Lead } from '@/types/database'

/** Local YYYY-MM-DD for an <input type="date">, `days` from today. */
function dateInputValue(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const PRESETS: { label: string; days: number }[] = [
  { label: '+3 days', days: 3 },
  { label: '+1 week', days: 7 },
  { label: '+2 weeks', days: 14 },
  { label: '+1 month', days: 30 },
]

export function HoldLead({ lead }: { lead: Lead }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const alreadyHeld = !!lead.hold_until && new Date(lead.hold_until).getTime() > Date.now()
  const [date, setDate] = useState<string>(
    lead.hold_until ? lead.hold_until.slice(0, 10) : dateInputValue(7),
  )
  const [reason, setReason] = useState<string>(lead.hold_reason ?? '')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!date) { toast.error('Pick a date'); return }
    setSaving(true)
    try {
      const holdUntil = new Date(`${date}T12:00:00`).toISOString() // noon-local, no UTC shift
      const res = await fetch(`/api/leads/${lead.id}/hold`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ holdUntil, reason: reason.trim() || null }),
      })
      if (!res.ok) throw new Error(String(res.status))
      toast.success(`On hold until ${date} — automation paused`)
      setOpen(false)
      router.refresh()
    } catch { toast.error('Could not save. Try again.') } finally { setSaving(false) }
  }

  async function clear() {
    setSaving(true)
    try {
      const res = await fetch(`/api/leads/${lead.id}/hold`, { method: 'DELETE' })
      if (!res.ok) throw new Error(String(res.status))
      toast.success('Hold cleared')
      setOpen(false)
      router.refresh()
    } catch { toast.error('Could not clear. Try again.') } finally { setSaving(false) }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <PauseCircle className="h-4 w-4" strokeWidth={1.75} />
            {alreadyHeld ? 'On hold' : 'Hold'}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{alreadyHeld ? 'Update hold' : 'Put lead on hold'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <Button key={p.days} type="button" variant="ghost" size="sm"
                onClick={() => setDate(dateInputValue(p.days))}>
                {p.label}
              </Button>
            ))}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="hold-date">Hold until</Label>
            <Input id="hold-date" type="date" value={date} min={dateInputValue(1)}
              onChange={(e) => setDate(e.target.value)} />
            <p className="text-[11px] text-aurea-ink-3">
              No automated calls, texts, or emails until this date. You can still reach out manually.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="hold-reason">Reason (optional)</Label>
            <Input id="hold-reason" placeholder="e.g. wants to talk it over with spouse"
              value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          {alreadyHeld && (
            <Button variant="ghost" onClick={clear} disabled={saving}>Clear hold</Button>
          )}
          <DialogClose render={<Button variant="ghost">Cancel</Button>} />
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <PauseCircle className="h-4 w-4" strokeWidth={1.75} />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit`

```bash
git add src/components/crm/hold-lead.tsx
git commit -m "feat(ui): HoldLead dialog control"
```

---

## Task 15: UI — badge + wire into the action bar

**Files:**
- Create: `src/components/crm/hold-badge.tsx`
- Modify: `src/components/crm/lead-actions.tsx` — import (:37 area) + render (~:448, beside `MarkDeliberating`)

- [ ] **Step 1: Write the badge**

```tsx
// src/components/crm/hold-badge.tsx
import { PauseCircle } from 'lucide-react'
import type { Lead } from '@/types/database'

/** "On hold until Aug 3" pill. Renders nothing when the lead is not on hold. */
export function HoldBadge({ lead }: { lead: Pick<Lead, 'hold_until'> }) {
  if (!lead.hold_until || new Date(lead.hold_until).getTime() <= Date.now()) return null
  const when = new Date(lead.hold_until).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
      <PauseCircle className="h-3 w-3" strokeWidth={2} />
      On hold until {when}
    </span>
  )
}
```

- [ ] **Step 2: Render `HoldLead` in the action bar**

In `src/components/crm/lead-actions.tsx`, add the import near line 37:

```typescript
import { HoldLead } from './hold-lead'
```

At the `MarkDeliberating` render site (~:448), add `HoldLead` alongside it (Hold applies to any lead, so it is NOT gated to the deliberating statuses):

```tsx
        ) && <MarkDeliberating lead={lead} />}
        {variant !== 'compact' && <HoldLead lead={lead} />}
```

(Match the surrounding conditional style; `HoldLead` renders for any non-compact variant.)

- [ ] **Step 3: Render the badge in lead detail**

In `src/components/crm/lead-detail.tsx`, near the action row (:345), add the badge import and render `<HoldBadge lead={lead} />` in the header area beside the lead's name/status. (Read :330-355 first to place it in the existing header block.)

- [ ] **Step 4: Typecheck + commit**

Run: `npx tsc --noEmit`

```bash
git add src/components/crm/hold-badge.tsx src/components/crm/lead-actions.tsx src/components/crm/lead-detail.tsx
git commit -m "feat(ui): hold badge + Hold control in the lead action bar"
```

---

## Task 16: End-to-end verification in the browser

**Files:** none (verification only)

- [ ] **Step 1: Apply migrations to the dev DB**

Run the two new migrations against the dev/branch database (via the Supabase MCP `apply_migration`, or the CLI if wired). Confirm `leads.hold_until` and the `callback` kind exist.

- [ ] **Step 2: Run the full unit suite**

Run: `npx vitest run src/lib/leads src/lib/campaigns/eligibility.test.ts src/lib/automation/hold-tasks.test.ts src/lib/voice/call-manager.test.ts`
Expected: all PASS.

- [ ] **Step 3: Drive it in the app**

Start the dev server (preview_start `{name}` from `.claude/launch.json`). On a test lead:
1. Open lead detail → click **Hold** → pick +1 week → Save.
2. Confirm the toast, the "On hold until …" badge, and a new **callback** task on `/tasks` with the right due date.
3. Confirm the lead no longer appears in the dialer queue (`/dialer` or the queue view).
4. Click **Clear hold** → confirm the badge disappears and the callback task is marked done.

Capture a screenshot of the badge + the `/tasks` callback row as proof.

- [ ] **Step 4: Final commit (if any verification fixups were needed)**

```bash
git add -A && git commit -m "test(leads): verify hold end-to-end"
```

---

## Self-review notes (for the implementer)

- **Choke-point coverage:** dialer queue (T5), campaign dialer (T6), consent gate (T7), smart lists + eligibility (T8), send-authorization (T9), pre-call gate (T10). All six paths the spec named are covered. If you add a new outbound path, route it through `applyNotOnHold` / `isOnHold`.
- **Human override:** no code blocks a human dial/send. `assertConsent` and `assertCampaignSendAllowed` only deny automation callers; `preCallCheck` is not consulted for the hold decision on a staff softphone dial (confirm this when wiring the softphone — if it DOES call `preCallCheck`, add a `humanPlaced` bypass for the hold gate specifically).
- **No stale dates:** every consumer checks `hold_until > now`, and `expireHolds` (T12) nulls the column, so a past `hold_until` never lingers.
- **Migration replay:** T2 carries the full 11-kind list; `lead_activities` needs no change (regex constraint).
