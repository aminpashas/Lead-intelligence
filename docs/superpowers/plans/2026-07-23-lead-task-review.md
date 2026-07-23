# Lead-page Task Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface a lead's live `human_tasks` on the lead detail page with a "Still relevant" / Snooze / Done / Dismiss control set, so tasks stop going stale.

**Architecture:** Hybrid fetch — the lead page server-renders the lead's live tasks into its existing `Promise.all`, passes them to a new self-contained `<LeadTaskCard>` pinned above the conversation thread; the card owns state and mutates via `PATCH /api/tasks/[id]`. Two new PATCH actions (`review`, `snooze`) and a `reviewed_at`/`reviewed_by` column pair let "a human confirmed this" become queryable state. A pure `isPossiblyMoot()` helper flags tasks whose lead was worked since the task was created.

**Tech Stack:** Next.js 16 (App Router, RSC), TypeScript, Supabase (PostgreSQL + RLS), Zod, Vitest (+ jsdom for the component test), Tailwind, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-07-22-lead-task-review-design.md`

---

## File Structure

- **Create** `supabase/migrations/20260723120000_human_tasks_reviewed_at.sql` — adds `reviewed_at` + `reviewed_by`. Columns only; does **not** touch any CHECK constraint.
- **Modify** `src/lib/automation/tasks.ts` — add `reviewed_at` / `reviewed_by` to the `HumanTask` row type.
- **Modify** `src/app/api/tasks/route.ts` (GET) — accept `lead_id` filter; add the two columns to the select.
- **Modify** `src/app/api/tasks/[id]/route.ts` (PATCH) — add `review` + `snooze` actions via a discriminated-union body schema.
- **Create** `src/lib/tasks/moot.ts` — pure `isPossiblyMoot(task, lastContactedAt)` helper (unit-testable without React).
- **Create** `src/lib/tasks/moot.test.ts` — helper tests.
- **Create** `src/components/crm/lead-task-card.tsx` — the card. Renders nothing when there are no live tasks.
- **Create** `src/components/crm/lead-task-card.test.tsx` — component tests (jsdom).
- **Modify** `src/app/(dashboard)/leads/[id]/page.tsx` — fetch live tasks into the existing `Promise.all`, pass `tasks` to `LeadDetail`.
- **Modify** `src/components/crm/lead-detail.tsx` — accept `tasks`, render `<LeadTaskCard>` above the thread.
- **Modify** `src/app/api/tasks/[id]/route.test.ts` (create if absent) — PATCH action tests.

---

## Task 1: Migration + row type — `reviewed_at` / `reviewed_by`

**Files:**
- Create: `supabase/migrations/20260723120000_human_tasks_reviewed_at.sql`
- Modify: `src/lib/automation/tasks.ts` (the `HumanTask` type, ends ~line 84)

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260723120000_human_tasks_reviewed_at.sql`:

```sql
-- human_tasks: reviewed_at / reviewed_by  (lead-page task review)
--
-- WHAT: a human working a lead can confirm a task is "still relevant" without
-- changing its status. reviewed_at records that confirmation; reviewed_by is who
-- did it. This makes "a human looked at this today" queryable state rather than
-- an inference, and drives the lead page's "Possibly moot" flag (a task is moot
-- only if it has NOT been reviewed since the lead was last contacted).
--
-- COLUMNS ONLY — this migration deliberately does NOT touch human_tasks_kind_check
-- or human_tasks_status_check. No new kind or status is introduced, so it avoids
-- the full-list drop/recreate replay hazard those constraints carry (see
-- 20260716140000_human_tasks_follow_up.sql). reviewed_at mirrors the naming
-- already used by campaign_review_drafts.reviewed_at.
--
-- Guarded (human_tasks is branch-new) and idempotent.
DO $$
BEGIN
  IF to_regclass('public.human_tasks') IS NOT NULL THEN
    ALTER TABLE public.human_tasks
      ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
      ADD COLUMN IF NOT EXISTS reviewed_by uuid
        REFERENCES public.user_profiles(id) ON DELETE SET NULL;
  END IF;
END $$;
```

- [ ] **Step 2: Apply the migration to the database**

This project applies migrations via the Supabase MCP `apply_migration` tool (or the Supabase CLI). Apply the SQL above with migration name `human_tasks_reviewed_at`. The repo file and the live schema must both be updated — applying without committing the file (or vice versa) is the drift this project has hit before.

Verify the columns exist:

```sql
select column_name from information_schema.columns
where table_name = 'human_tasks' and column_name in ('reviewed_at','reviewed_by');
```

Expected: two rows.

- [ ] **Step 3: Add the fields to the `HumanTask` row type**

In `src/lib/automation/tasks.ts`, inside `export type HumanTask = { ... }`, add after the `completed_at: string | null` line:

```ts
  completed_at: string | null
  reviewed_at: string | null
  reviewed_by: string | null
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors from `tasks.ts` (pre-existing errors elsewhere, if any, are out of scope — confirm none reference `reviewed_at`).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260723120000_human_tasks_reviewed_at.sql src/lib/automation/tasks.ts
git commit -m "feat(tasks): add human_tasks.reviewed_at/reviewed_by"
```

---

## Task 2: GET `/api/tasks` — `lead_id` filter + review columns

**Files:**
- Modify: `src/app/api/tasks/route.ts`

Read the current file first — the branch has moved since the spec was written; confirm the GET handler and its `.select(...)` string match what's described below before editing.

- [ ] **Step 1: Add the two columns to the GET select**

In `src/app/api/tasks/route.ts`, in the `GET` handler's `.select(\` ... \`)` block, add `reviewed_at` and `reviewed_by` to the column list (after `completed_at,`):

```ts
      completed_at,
      reviewed_at,
      reviewed_by,
      source,
```

- [ ] **Step 2: Parse and apply the `lead_id` filter**

In `GET`, after the existing `const assignee = ...` line, add:

```ts
  // Optional lead scoping (the lead detail page). Malformed ids are ignored
  // rather than erroring, matching how status/kind degrade to defaults.
  const leadIdParam = url.searchParams.get('lead_id')
  const leadId =
    leadIdParam && z.string().uuid().safeParse(leadIdParam).success ? leadIdParam : null
```

Then, after the existing `if (kind) query = query.eq('kind', kind)` line, add:

```ts
  if (leadId) query = query.eq('lead_id', leadId)
```

(`z` is already imported at the top of this file.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/tasks/route.ts
git commit -m "feat(tasks): GET /api/tasks accepts lead_id filter + reviewed_at columns"
```

---

## Task 3: PATCH `/api/tasks/[id]` — `review` + `snooze` actions

**Files:**
- Modify: `src/app/api/tasks/[id]/route.ts`
- Test: `src/app/api/tasks/[id]/route.test.ts` (create)

Read `src/app/api/tasks/[id]/route.ts` first. The steps below assume the schema is still `z.object({ action: z.enum(['claim','complete','dismiss']) })` and the handler switches on `action`.

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/tasks/[id]/route.test.ts`. This tests the pure request→response behavior by mocking the Supabase client the route builds. Mirror the mock shape the route uses (`getOwnProfile`, `resolveActiveOrg`, `createClient`).

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => ({
  task: { id: 't1', status: 'open', claimed_by: null, due_at: null } as Record<string, unknown>,
  updateArgs: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: state.task }) }),
        }),
      }),
      update: (args: Record<string, unknown>) => {
        state.updateArgs = args
        return {
          eq: () => ({
            eq: () => ({
              select: () => ({ single: async () => ({ data: { id: 't1', ...args }, error: null }) }),
            }),
          }),
        }
      },
    }),
  })),
}))
vi.mock('@/lib/auth/active-org', () => ({
  getOwnProfile: vi.fn(async () => ({ data: { id: 'user-1', organization_id: 'org-1' } })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: 'org-1' })),
}))
vi.mock('@/lib/webhooks/verify', () => ({ applyRateLimit: () => null }))
vi.mock('@/lib/rate-limit', () => ({ RATE_LIMITS: { api: {} } }))

import { PATCH } from './route'

function req(body: unknown) {
  return new NextRequest('http://t/api/tasks/t1', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}
const params = Promise.resolve({ id: '11111111-1111-1111-1111-111111111111' })

beforeEach(() => {
  state.task = { id: 't1', status: 'open', claimed_by: null, due_at: null }
  state.updateArgs = null
})

describe('PATCH /api/tasks/[id] review', () => {
  it('sets reviewed_at/reviewed_by and leaves status unchanged', async () => {
    const res = await PATCH(req({ action: 'review' }), { params })
    expect(res.status).toBe(200)
    expect(state.updateArgs).toMatchObject({ reviewed_by: 'user-1' })
    expect(state.updateArgs?.reviewed_at).toEqual(expect.any(String))
    expect(state.updateArgs).not.toHaveProperty('status')
  })

  it('409s on a terminal task', async () => {
    state.task = { id: 't1', status: 'done', claimed_by: null, due_at: null }
    const res = await PATCH(req({ action: 'review' }), { params })
    expect(res.status).toBe(409)
  })
})

describe('PATCH /api/tasks/[id] snooze', () => {
  it('moves due_at ~N days out and stamps reviewed_at', async () => {
    const res = await PATCH(req({ action: 'snooze', snooze_days: 7 }), { params })
    expect(res.status).toBe(200)
    const due = new Date(state.updateArgs?.due_at as string).getTime()
    const now = Date.now()
    expect(due).toBeGreaterThan(now + 6.5 * 864e5)
    expect(due).toBeLessThan(now + 7.5 * 864e5)
    expect(state.updateArgs?.reviewed_at).toEqual(expect.any(String))
  })

  it('400s when neither snooze_days nor due_at is given', async () => {
    const res = await PATCH(req({ action: 'snooze' }), { params })
    expect(res.status).toBe(400)
  })

  it('400s on a past due_at', async () => {
    const res = await PATCH(req({ action: 'snooze', due_at: '2020-01-01T00:00:00.000Z' }), { params })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run "src/app/api/tasks/[id]/route.test.ts"`
Expected: FAIL — `review`/`snooze` are rejected by the current `z.enum(['claim','complete','dismiss'])` schema, so those requests 400 instead of 200.

- [ ] **Step 3: Replace the body schema with a discriminated union**

In `src/app/api/tasks/[id]/route.ts`, replace:

```ts
const taskPatchSchema = z.object({
  action: z.enum(['claim', 'complete', 'dismiss']),
})
```

with:

```ts
const taskPatchSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('claim') }),
  z.object({ action: z.literal('complete') }),
  z.object({ action: z.literal('dismiss') }),
  z.object({ action: z.literal('review') }),
  z.object({
    action: z.literal('snooze'),
    // Exactly one of the two must be supplied (refined below).
    snooze_days: z.number().int().min(1).max(90).optional(),
    due_at: z.string().datetime({ offset: true }).optional(),
  }),
])
```

Add, immediately after the `const { action } = parsed.data` line (or replace the existing destructure so the union type is preserved):

```ts
  const data = parsed.data
  const action = data.action
```

- [ ] **Step 4: Add the two cases to the action switch**

The existing switch sets fields on `updates` (a `Record<string, unknown>` seeded with `updated_at: now`). It runs **after** the task's current status is loaded into `task`. Add these two `case`s alongside `claim`/`complete`/`dismiss`. Both require a live task:

```ts
    case 'review':
      if (task.status !== 'open' && task.status !== 'claimed') {
        return NextResponse.json(
          { error: `Cannot review a task in status "${task.status}"` },
          { status: 409 }
        )
      }
      updates.reviewed_at = now
      updates.reviewed_by = profile.id
      break
    case 'snooze': {
      if (task.status !== 'open' && task.status !== 'claimed') {
        return NextResponse.json(
          { error: `Cannot snooze a task in status "${task.status}"` },
          { status: 409 }
        )
      }
      let nextDue: string
      if (data.action === 'snooze' && data.due_at) {
        if (new Date(data.due_at).getTime() <= Date.now()) {
          return NextResponse.json({ error: 'due_at must be in the future' }, { status: 400 })
        }
        nextDue = data.due_at
      } else if (data.action === 'snooze' && typeof data.snooze_days === 'number') {
        nextDue = new Date(Date.now() + data.snooze_days * 24 * 60 * 60 * 1000).toISOString()
      } else {
        return NextResponse.json(
          { error: 'snooze requires snooze_days or a future due_at' },
          { status: 400 }
        )
      }
      updates.due_at = nextDue
      // Snoozing is a review — record that a human looked at this.
      updates.reviewed_at = now
      updates.reviewed_by = profile.id
      break
    }
```

Note: the "neither given" and "both given / past date" validation lives in the handler (Step 4), not only in Zod, because `.optional()` on both fields lets an empty snooze body pass schema validation. That is intentional — it keeps the union simple and puts the future-date check (which needs runtime `Date.now()`) in one place.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run "src/app/api/tasks/[id]/route.test.ts"`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors. If TS complains that `data.snooze_days` / `data.due_at` don't exist on the union, the `data.action === 'snooze'` guards above are what narrow it — keep them.

- [ ] **Step 7: Commit**

```bash
git add "src/app/api/tasks/[id]/route.ts" "src/app/api/tasks/[id]/route.test.ts"
git commit -m "feat(tasks): PATCH review + snooze actions"
```

---

## Task 4: `isPossiblyMoot` helper

**Files:**
- Create: `src/lib/tasks/moot.ts`
- Test: `src/lib/tasks/moot.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/tasks/moot.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isPossiblyMoot } from '@/lib/tasks/moot'

const CREATED = '2026-07-10T12:00:00.000Z'

describe('isPossiblyMoot', () => {
  it('is true when the lead was contacted after the task was created and never reviewed', () => {
    expect(
      isPossiblyMoot(
        { created_at: CREATED, reviewed_at: null },
        '2026-07-12T09:00:00.000Z'
      )
    ).toBe(true)
  })

  it('is false when the lead was last contacted before the task was created', () => {
    expect(
      isPossiblyMoot(
        { created_at: CREATED, reviewed_at: null },
        '2026-07-09T09:00:00.000Z'
      )
    ).toBe(false)
  })

  it('is false when reviewed after the last contact', () => {
    expect(
      isPossiblyMoot(
        { created_at: CREATED, reviewed_at: '2026-07-12T10:00:00.000Z' },
        '2026-07-12T09:00:00.000Z'
      )
    ).toBe(false)
  })

  it('is true when reviewed, but the lead was contacted again after that review', () => {
    expect(
      isPossiblyMoot(
        { created_at: CREATED, reviewed_at: '2026-07-11T10:00:00.000Z' },
        '2026-07-12T09:00:00.000Z'
      )
    ).toBe(true)
  })

  it('is false when the lead has never been contacted', () => {
    expect(isPossiblyMoot({ created_at: CREATED, reviewed_at: null }, null)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/tasks/moot.test.ts`
Expected: FAIL — `Cannot find module '@/lib/tasks/moot'`.

- [ ] **Step 3: Write the helper**

Create `src/lib/tasks/moot.ts`:

```ts
/**
 * A live task is "possibly moot" when the lead has been worked since the task
 * was created and nobody has confirmed the task since that work.
 *
 * Two conditions, both required:
 *   1. lastContactedAt > task.created_at  — the lead was contacted after the
 *      task was minted.
 *   2. task.reviewed_at is null OR reviewed_at < lastContactedAt — no human has
 *      confirmed the task since that contact.
 *
 * `lastContactedAt` is leads.last_contacted_at, which in this project means a
 * real conversation, not a dial attempt — so a task is never questioned just
 * because someone let the phone ring. Pure and render-time; nothing is stored.
 */
export function isPossiblyMoot(
  task: { created_at: string; reviewed_at: string | null },
  lastContactedAt: string | null
): boolean {
  if (!lastContactedAt) return false
  const contacted = new Date(lastContactedAt).getTime()
  if (!(contacted > new Date(task.created_at).getTime())) return false
  if (task.reviewed_at && new Date(task.reviewed_at).getTime() >= contacted) return false
  return true
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/tasks/moot.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tasks/moot.ts src/lib/tasks/moot.test.ts
git commit -m "feat(tasks): isPossiblyMoot helper"
```

---

## Task 5: `LeadTaskCard` component

**Files:**
- Create: `src/components/crm/lead-task-card.tsx`
- Test: `src/components/crm/lead-task-card.test.tsx`

The card's own row type is defined here (a subset of `human_tasks` columns the card renders). It does **not** import `HumanTask` from `tasks.ts` — that type carries encrypted/PII-adjacent fields the card never sees.

- [ ] **Step 1: Write the failing test**

Create `src/components/crm/lead-task-card.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { LeadTaskCard, type LeadTask } from '@/components/crm/lead-task-card'

const refresh = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh }),
}))
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: toastError } }))

const TASK: LeadTask = {
  id: 'task-1',
  kind: 'callback',
  title: 'Call the patient back Friday',
  detail: null,
  status: 'open',
  priority: 'normal',
  due_at: null,
  assigned_to: null,
  reviewed_at: null,
  created_at: '2026-07-10T12:00:00.000Z',
}

const TEAM = [{ id: 'user-2', full_name: 'Marcus', email: 'm@x.co', role: 'agent' }]

function fetchOk() {
  return vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
}

beforeEach(() => vi.stubGlobal('fetch', fetchOk()))
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('LeadTaskCard', () => {
  it('renders nothing when there are no live tasks', () => {
    const { container } = render(
      <LeadTaskCard leadId="lead-1" initialTasks={[]} teamMembers={TEAM} lastContactedAt={null} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders a row per task', () => {
    render(
      <LeadTaskCard leadId="lead-1" initialTasks={[TASK]} teamMembers={TEAM} lastContactedAt={null} />
    )
    expect(screen.getByText('Call the patient back Friday')).toBeTruthy()
  })

  it('flags a task as possibly moot when the lead was contacted after it was created', () => {
    render(
      <LeadTaskCard
        leadId="lead-1"
        initialTasks={[TASK]}
        teamMembers={TEAM}
        lastContactedAt="2026-07-12T09:00:00.000Z"
      />
    )
    expect(screen.getByText(/still needed/i)).toBeTruthy()
  })

  it('does NOT flag when the lead was contacted before it was created', () => {
    render(
      <LeadTaskCard
        leadId="lead-1"
        initialTasks={[TASK]}
        teamMembers={TEAM}
        lastContactedAt="2026-07-09T09:00:00.000Z"
      />
    )
    expect(screen.queryByText(/still needed/i)).toBeNull()
  })

  it('"Still relevant" PATCHes review and clears the moot flag without removing the row', async () => {
    render(
      <LeadTaskCard
        leadId="lead-1"
        initialTasks={[TASK]}
        teamMembers={TEAM}
        lastContactedAt="2026-07-12T09:00:00.000Z"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /still relevant/i }))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/tasks/task-1',
        expect.objectContaining({ method: 'PATCH' })
      )
    )
    expect(screen.getByText('Call the patient back Friday')).toBeTruthy()
    await waitFor(() => expect(screen.queryByText(/still needed/i)).toBeNull())
  })

  it('reverts and toasts on a failed update', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ error: 'nope' }) })))
    render(
      <LeadTaskCard leadId="lead-1" initialTasks={[TASK]} teamMembers={TEAM} lastContactedAt={null} />
    )
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(screen.getByText('Call the patient back Friday')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/crm/lead-task-card.test.tsx`
Expected: FAIL — `Cannot find module '@/components/crm/lead-task-card'`.

- [ ] **Step 3: Write the component**

Create `src/components/crm/lead-task-card.tsx`:

```tsx
'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { isPossiblyMoot } from '@/lib/tasks/moot'
import { CheckCircle2, Clock, X, AlarmClock, ChevronDown, AlertTriangle } from 'lucide-react'

type Priority = 'low' | 'normal' | 'high' | 'urgent'

/** The columns the card renders — a subset of human_tasks. */
export type LeadTask = {
  id: string
  kind: string
  title: string
  detail: string | null
  status: 'open' | 'claimed'
  priority: Priority
  due_at: string | null
  assigned_to: string | null
  reviewed_at: string | null
  created_at: string
}

type TeamMember = { id: string; full_name: string | null; email: string; role: string }

const PRIORITY_RANK: Record<Priority, number> = { urgent: 3, high: 2, normal: 1, low: 0 }

const SNOOZE_PRESETS: { label: string; days: number }[] = [
  { label: 'Tomorrow', days: 1 },
  { label: '3 days', days: 3 },
  { label: '1 week', days: 7 },
  { label: '2 weeks', days: 14 },
]

function PriorityBadge({ priority }: { priority: Priority }) {
  if (priority !== 'high' && priority !== 'urgent') return null
  return (
    <Badge
      variant="outline"
      className={cn(
        'text-[10px] h-4 px-1.5 capitalize',
        priority === 'urgent'
          ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
          : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
      )}
    >
      {priority}
    </Badge>
  )
}

function DueChip({ dueAt }: { dueAt: string }) {
  const overdue = new Date(dueAt).getTime() < Date.now()
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[11px]',
        overdue ? 'text-red-600 dark:text-red-400' : 'text-aurea-ink-3'
      )}
    >
      <Clock className="h-3 w-3" strokeWidth={1.75} />
      {overdue ? 'Overdue ' : 'Due '}
      {formatDistanceToNow(new Date(dueAt), { addSuffix: !overdue })}
    </span>
  )
}

/** Client-side ordering: overdue first, then future-due asc, then priority, then newest. */
function sortTasks(tasks: LeadTask[]): LeadTask[] {
  return [...tasks].sort((a, b) => {
    const ad = a.due_at ? new Date(a.due_at).getTime() : null
    const bd = b.due_at ? new Date(b.due_at).getTime() : null
    if (ad !== null && bd !== null) return ad - bd
    if (ad !== null) return -1
    if (bd !== null) return 1
    if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority])
      return PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })
}

export function LeadTaskCard({
  leadId: _leadId,
  initialTasks,
  teamMembers,
  lastContactedAt,
}: {
  leadId: string
  initialTasks: LeadTask[]
  teamMembers: TeamMember[]
  lastContactedAt: string | null
}) {
  const router = useRouter()
  const [tasks, setTasks] = useState<LeadTask[]>(initialTasks)
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  const nameFor = useMemo(() => {
    const map = new Map(teamMembers.map((m) => [m.id, m.full_name || m.email]))
    return (id: string | null) => (id ? map.get(id) ?? 'Assigned' : 'Unassigned')
  }, [teamMembers])

  const sorted = useMemo(() => sortTasks(tasks), [tasks])

  if (tasks.length === 0) return null

  async function patch(id: string, body: Record<string, unknown>) {
    const res = await fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      throw new Error(j.error || 'Update failed')
    }
    return res
  }

  // Optimistically apply `optimistic` to the row; on failure restore `prev`.
  async function run(
    id: string,
    body: Record<string, unknown>,
    optimistic: (t: LeadTask) => LeadTask | null
  ) {
    const prev = tasks
    setBusy((b) => ({ ...b, [id]: true }))
    setTasks((ts) =>
      ts.flatMap((t) => {
        if (t.id !== id) return [t]
        const next = optimistic(t)
        return next ? [next] : []
      })
    )
    try {
      await patch(id, body)
      router.refresh()
    } catch (e) {
      setTasks(prev)
      toast.error(e instanceof Error ? e.message : 'Update failed')
    } finally {
      setBusy((b) => ({ ...b, [id]: false }))
    }
  }

  const nowIso = () => new Date().toISOString()

  return (
    <div className="border-b border-aurea-border bg-aurea-surface-2/40 px-4 py-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-aurea-ink-3">
        <AlarmClock className="h-3.5 w-3.5" strokeWidth={1.75} />
        {tasks.length === 1 ? '1 open task' : `${tasks.length} open tasks`}
        {initialTasks.length >= 20 && (
          <a href="/tasks" className="ml-1 normal-case text-aurea-ink-3 underline">
            more may exist — view all
          </a>
        )}
      </div>
      <ul className="space-y-2">
        {sorted.map((t) => {
          const moot = isPossiblyMoot(t, lastContactedAt)
          const isBusy = !!busy[t.id]
          return (
            <li
              key={t.id}
              className={cn(
                'rounded-md border bg-aurea-surface px-3 py-2',
                moot ? 'border-l-2 border-l-amber-500 border-aurea-border' : 'border-aurea-border'
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] text-aurea-ink">{t.title}</span>
                    <PriorityBadge priority={t.priority} />
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-aurea-ink-3">
                    {t.due_at && <DueChip dueAt={t.due_at} />}
                    <span>{nameFor(t.assigned_to)}</span>
                    <span>
                      {t.reviewed_at
                        ? `Reviewed ${formatDistanceToNow(new Date(t.reviewed_at), { addSuffix: true })}`
                        : 'Never reviewed'}
                    </span>
                  </div>
                  {moot && (
                    <div className="mt-1 flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400">
                      <AlertTriangle className="h-3 w-3" strokeWidth={1.75} />
                      Lead was contacted since this was created — still needed?
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isBusy}
                    className="h-7 px-2 text-[11px]"
                    onClick={() => run(t.id, { action: 'review' }, (x) => ({ ...x, reviewed_at: nowIso() }))}
                  >
                    Still relevant
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="ghost" disabled={isBusy} className="h-7 gap-0.5 px-2 text-[11px]">
                        Snooze <ChevronDown className="h-3 w-3" strokeWidth={1.75} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {SNOOZE_PRESETS.map((p) => (
                        <DropdownMenuItem
                          key={p.days}
                          onClick={() =>
                            run(
                              t.id,
                              { action: 'snooze', snooze_days: p.days },
                              (x) => ({
                                ...x,
                                reviewed_at: nowIso(),
                                due_at: new Date(Date.now() + p.days * 864e5).toISOString(),
                              })
                            )
                          }
                        >
                          {p.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isBusy}
                    className="h-7 px-2 text-[11px] text-aurea-ink-2"
                    onClick={() => run(t.id, { action: 'complete' }, () => null)}
                  >
                    <CheckCircle2 className="mr-1 h-3.5 w-3.5" strokeWidth={1.75} /> Done
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isBusy}
                    aria-label="Dismiss task"
                    className="h-7 w-7 p-0 text-aurea-ink-3"
                    onClick={() => run(t.id, { action: 'dismiss' }, () => null)}
                  >
                    <X className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </Button>
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/crm/lead-task-card.test.tsx`
Expected: PASS (6 tests). If the dropdown component path differs, confirm `@/components/ui/dropdown-menu` exists (`ls src/components/ui/dropdown-menu.tsx`); it's a standard shadcn primitive in this repo.

- [ ] **Step 5: Commit**

```bash
git add src/components/crm/lead-task-card.tsx src/components/crm/lead-task-card.test.tsx
git commit -m "feat(tasks): LeadTaskCard with review/snooze/done/dismiss + moot flag"
```

---

## Task 6: Wire the card into the lead page

**Files:**
- Modify: `src/app/(dashboard)/leads/[id]/page.tsx`
- Modify: `src/components/crm/lead-detail.tsx`

- [ ] **Step 1: Fetch live tasks in the page's `Promise.all`**

In `src/app/(dashboard)/leads/[id]/page.tsx`, add a destructured entry to the existing `Promise.all([...])` array (alongside `activities`, `conversations`, etc.). Add the binding to the destructure on the left:

```ts
    { data: leadTasks },
```

and the query as a new array element:

```ts
    supabase
      .from('human_tasks')
      .select(
        'id, kind, title, detail, status, priority, due_at, assigned_to, reviewed_at, created_at'
      )
      .eq('lead_id', id)
      .eq('organization_id', lead.organization_id)
      .in('status', ['open', 'claimed'])
      .order('due_at', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(20),
```

- [ ] **Step 2: Pass the tasks to `LeadDetail`**

In the same file's `return <LeadDetail ... />`, add the prop:

```tsx
      tasks={leadTasks || []}
```

- [ ] **Step 3: Accept and render the prop in `LeadDetail`**

In `src/components/crm/lead-detail.tsx`:

Add the import near the other CRM imports (e.g. after the `ConversationThread` import):

```ts
import { LeadTaskCard, type LeadTask } from './lead-task-card'
```

Add `tasks` to the destructured props and the prop-types block. In the destructure (the `{ ... }` argument list), add:

```ts
  tasks = [],
```

In the type annotation block, add:

```ts
  /** Live (open/claimed) human_tasks for this lead, server-fetched. */
  tasks?: LeadTask[]
```

Render the card just inside the hero `<section>`, **between** the top strip `</div>` and the body `<div className="min-h-0 flex-1">`, so it sits above both Thread and Timeline. Insert:

```tsx
        <LeadTaskCard
          leadId={lead.id}
          initialTasks={tasks}
          teamMembers={teamMembers}
          lastContactedAt={lead.last_contacted_at}
        />
```

(`teamMembers` and `lead` are already in scope in this component.)

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors. `teamMembers`'s element type (`Pick<UserProfile,'id'|'full_name'|'email'|'role'>`) is assignable to the card's `TeamMember`.

- [ ] **Step 5: Run the full task-related test set**

Run: `npx vitest run src/lib/tasks src/components/crm/lead-task-card.test.tsx "src/app/api/tasks/[id]/route.test.ts"`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/leads/[id]/page.tsx" src/components/crm/lead-detail.tsx
git commit -m "feat(tasks): render LeadTaskCard on the lead detail page"
```

---

## Task 7: Manual verification + final check

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: build succeeds. Type errors block the Vercel deploy, so a green build here is the gate.

- [ ] **Step 2: Browser smoke (optional but recommended)**

Start the dev server via the preview tooling, open a lead that has a live task (create one from `/tasks` linked to the lead if none exists), and confirm: the card renders above the thread; "Still relevant" leaves the row but updates "Reviewed just now"; Snooze → 1 week updates the due chip; Done/Dismiss remove the row; a lead with no task shows no card.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin <branch>
gh pr create --base main --title "feat(tasks): lead-page task review" \
  --body "Implements docs/superpowers/specs/2026-07-22-lead-task-review-design.md"
```

---

## Notes for the implementer

- **Branch off `main`.** This feature is independent of the AI-delegation work in PR #166. Do not build on top of that branch.
- **Deploy order is migration-first.** The GET query selects `reviewed_at`; if the column isn't in production when the code deploys, the lead page's task query errors. Task 1 applies the migration before any code references the column.
- **The moot flag is derived, never stored.** No task writes it; it's computed at render from `created_at`, `reviewed_at`, and the lead's `last_contacted_at`.
- **Out of scope (per spec):** reassignment, editing task fields, auto-close on activity, cron stale-flagging, and `reviewed_at` on the `/tasks` queue page.
