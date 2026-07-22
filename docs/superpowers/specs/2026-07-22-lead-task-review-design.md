# Lead-page task review

**Date:** 2026-07-22
**Status:** Approved, ready for implementation planning

## Problem

`human_tasks` rows carry a `lead_id`, but no lead-facing surface reads it. A rep
opening a lead sees the conversation, the timeline, the intelligence panel — and
no indication that two tasks are sitting on this lead in the org queue.

The consequence is stale tasks. Task closure is uneven by kind:

- **State-shaped** work (`kind = 'follow_up'`) self-heals. The sweep's
  `reconcile()` in `src/lib/automation/task-sweep.ts` closes those rows when the
  underlying condition clears, with a 30-day re-mint suppression.
- **Every other kind** — `manual`, `callback`, `inbound_reply`, `first_touch`,
  `list_call`, `recommendation` — closes only when a human clicks. Nothing
  reconciles them.

So a rep can call a lead, book them, move them to Consult Booked, and leave a
`callback` task from last week sitting open forever. The queue accumulates work
that is already done, and reps learn to distrust it.

The fix: surface a lead's live tasks on the lead page, where the human already
is, and give them a cheap way to say "still relevant" — so a deliberately-kept
task is distinguishable from one nobody has looked at.

## Scope

**In:** a task card on the lead detail page; a `lead_id` filter on the tasks
list API; two new PATCH actions (`review`, `snooze`); a `reviewed_at` /
`reviewed_by` column pair.

**Out:** reassignment, editing task fields, auto-closing tasks on lead activity,
any cron-driven stale flagging, and changes to the `/tasks` queue page. See
[Non-goals](#non-goals) for why each was rejected.

## Design decisions

Three decisions were settled before design and constrain everything below.

1. **Prominent, never blocking.** Live tasks render inline at the top of the
   lead page, above the conversation thread. No modal. A rep glancing at a
   thread is never interrupted.
2. **"Still relevant" is a first-class verb.** Beyond the existing
   Done / Dismiss, a rep can confirm a task without changing its status, and can
   snooze it. Confirming is recorded, so "a human checked this today" is
   queryable state rather than an inference.
3. **Nothing auto-closes.** Lead activity makes a task *ask louder*, never
   closes it. Mis-mapping an activity to a task silently destroys real work;
   the sweep's `reconcile()` is the only existing auto-close precedent and it is
   deliberately narrow (state-shaped `follow_up` only).

## Architecture

Hybrid fetch, matching the existing convention in
`src/components/crm/lead-detail.tsx` for `initialTags` and `notes`: the server
renders the first paint, the client owns state thereafter.

```
leads/[id]/page.tsx          server: live tasks joined into the existing Promise.all
  └─ LeadDetail              passes tasks straight through, holds no task state
       └─ LeadTaskCard       client: own state, optimistic mutations
            └─ PATCH /api/tasks/[id]   review | snooze | complete | dismiss
            └─ GET  /api/tasks?lead_id=…  (refetch path)
```

`LeadTaskCard` depends only on `leadId`, its initial rows, the team-member list,
the viewer's id, and the lead's `last_contacted_at` (which the moot flag in
section 4 needs). `lead-detail.tsx` — already 764 lines and the largest
client bundle on the page — gains one import and one JSX line, not a task state
machine.

### Why not the alternatives

- **Server-fetch only** (mutate via `router.refresh()`): every task update
  re-runs the page's ~15 parallel queries, and the card can't be reused.
- **Fully self-fetching card**: waterfalls after hydration on a page that SSRs
  everything else, so the card visibly pops in a beat late — bad for something
  whose entire job is being impossible to miss.

## 1. Data layer

New migration `supabase/migrations/20260722120000_human_tasks_reviewed_at.sql`:

```sql
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

Guarded and idempotent, matching every prior migration on this table.

**This migration must not touch `human_tasks_kind_check`.** No new `kind` is
needed. Every migration that has touched that constraint drops and recreates it
with a full hardcoded list, and one replayed out of order in production would
have silently dropped a kind — see the warning block in
`20260716140000_human_tasks_follow_up.sql`. Adding columns only avoids that
hazard entirely.

`reviewed_at` follows the naming already used elsewhere in the schema
(`campaign_review_drafts.reviewed_at`).

The `HumanTask` row type gains both fields in the same commit. It lives in
`src/lib/automation/tasks.ts`, **not** `src/types/database.ts`. TypeScript
errors block Vercel builds, so the type and the migration ship together.

### Migration application

The repo file and the production schema must both be updated. Applying the SQL
to production without committing the file (or vice versa) produces the drift
this project has hit before.

## 2. API

### `GET /api/tasks`

- Accept a `lead_id` query param. Validate as a UUID; ignore it if malformed
  rather than erroring, consistent with how `status` and `kind` already degrade
  to defaults on bad input.
- When present, add `.eq('lead_id', leadId)` to the query. This is the first
  read path to use the `human_tasks_lead_idx` index, which has existed since the
  table was created and is currently unread.
- Add `reviewed_at` and `reviewed_by` to the select list.

Note that `lead_id` composes with the existing filters — it does not replace
them. A request with `lead_id` and no `status` still defaults to `active`
(open + claimed).

### `PATCH /api/tasks/[id]`

The body schema becomes a discriminated union on `action`, so `snooze` can
require its own parameter while the other actions reject extras.

| action | allowed from | effect |
|---|---|---|
| `claim` | `open` | unchanged |
| `complete` | `open`, `claimed` | unchanged |
| `dismiss` | `open`, `claimed` | unchanged |
| `review` | `open`, `claimed` | sets `reviewed_at = now()`, `reviewed_by = caller`. **Status unchanged.** Idempotent — repeat calls just move the timestamp. |
| `snooze` | `open`, `claimed` | sets `due_at`, and also stamps `reviewed_at` / `reviewed_by` |

`snooze` takes **either** `snooze_days` (integer, 1–90) **or** an explicit
`due_at` (ISO-8601 with offset, must be in the future). Supplying both, neither,
or a past `due_at` is a 400.

Snooze writes the existing `due_at` column rather than introducing a separate
snooze field. A parallel field would let `src/lib/automation/sla.ts` and the
`human_tasks_org_status_due_idx` ordering disagree with what the rep was shown.

`review` and `snooze` on a terminal status (`done`, `dismissed`, `expired`,
`taken_by_ai`) return 409, matching the existing actions.

Both new actions are available to any authenticated org member, matching the
existing queue permissions — RLS scopes the row to the org, and the route
already re-checks `organization_id` before updating.

## 3. Server fetch

One additional query in the existing `Promise.all` in
`src/app/(dashboard)/leads/[id]/page.tsx`:

```ts
supabase
  .from('human_tasks')
  .select(
    'id, kind, title, detail, status, priority, due_at, ' +
    'assigned_to, claimed_by, reviewed_at, reviewed_by, source, created_at'
  )
  .eq('lead_id', id)
  .eq('organization_id', lead.organization_id)
  .in('status', ['open', 'claimed'])
  .order('due_at', { ascending: true, nullsFirst: false })
  .order('created_at', { ascending: false })
  .limit(20)
```

Passed to `LeadDetail` as a `tasks` prop, forwarded unchanged to
`LeadTaskCard`. The `organization_id` predicate is defence in depth — RLS
already scopes the read, but the page fetches by `lead_id` and an explicit org
filter keeps the query honest if RLS is ever relaxed.

Assignee display names resolve client-side from the `teamMembers` list the page
already fetches. No join is added.

## 4. Component: `src/components/crm/lead-task-card.tsx`

Rendered in `lead-detail.tsx` directly above the conversation thread.

**Renders nothing when there are no live tasks.** No empty state, no placeholder
— most leads have no task and must look exactly as they do today.

### Per-task row

- Kind icon and title.
- Priority pill, shown only for `high` / `urgent`, reusing the `PriorityBadge`
  treatment from `src/app/(dashboard)/tasks/tasks-list.tsx`.
- Due chip: "Due in 2 days", or red "Overdue 3 days" when past. Absent when
  `due_at` is null.
- Assignee name, or "Unassigned".
- Muted review line: "Reviewed 4h ago" or "Never reviewed".

### Actions

**Still relevant** · **Snooze ▾** · **Done** · **Dismiss**

Snooze presets: Tomorrow, 3 days, 1 week, 2 weeks — each sent as
`snooze_days` (1 / 3 / 7 / 14).

All four apply optimistically. On failure the row reverts to its prior state and
a `toast.error` fires with the server message. `Done` and `Dismiss` remove the
row from the card; `Still relevant` and `Snooze` keep it, updated in place.

### The "Possibly moot" flag

This is the sole mechanism by which lead activity affects a task. A task is
flagged when **both** hold:

1. `lead.last_contacted_at > task.created_at` — the lead has been worked since
   the task was minted, **and**
2. `task.reviewed_at` is null **or** `task.reviewed_at < lead.last_contacted_at`
   — nobody has confirmed the task since that work happened.

A flagged row gets an amber left border and the line *"Lead was contacted since
this was created — still needed?"*

Clicking **Still relevant** clears the flag immediately, because `reviewed_at`
moves past `last_contacted_at` and condition 2 stops holding. The flag is
derived at render time from data already on the page — it is not stored, and no
job computes it.

`last_contacted_at` is the right signal precisely because this project defines
it as a real conversation rather than a dial attempt. A task should not be
questioned because someone let the phone ring.

### Truncation

The server fetch caps at 20 rows. If exactly 20 come back, the card states that
more may exist and links to `/tasks`. Silent truncation would read as "this lead
has 20 tasks" when it may have 60.

### Ordering

The card sorts its own rows: overdue first (soonest overdue at top), then tasks
with a future `due_at` ascending, then undated tasks by priority descending,
then newest first.

The server query's `ORDER BY` (section 3) exists only to make the `.limit(20)`
cut deterministically — it decides *which* 20 rows come back, not the order they
render in. The two orderings are allowed to differ; the client's is what the rep
sees.

## 5. Testing

**`src/components/crm/lead-task-card.test.tsx`**

- Renders nothing when `initialTasks` is empty.
- Renders one row per live task with the correct title, assignee, and due chip.
- The moot flag appears when both predicate conditions hold.
- The moot flag is absent when the lead was contacted *before* the task was
  created (condition 1 fails).
- The moot flag is absent when `reviewed_at` is later than `last_contacted_at`
  (condition 2 fails).
- Clicking "Still relevant" issues `PATCH { action: 'review' }` and clears the
  flag without removing the row.
- A 500 response reverts the optimistic update and surfaces a toast.

**API tests**

- `review` sets `reviewed_at` / `reviewed_by` and leaves `status` untouched.
- `review` is idempotent across repeat calls.
- `snooze` with `snooze_days: 7` moves `due_at` roughly seven days out and also
  stamps `reviewed_at`.
- `snooze` with a past `due_at` returns 400.
- `snooze` with both `snooze_days` and `due_at` returns 400.
- `review` and `snooze` against a `done` task return 409.
- `GET /api/tasks?lead_id=…` returns only that lead's tasks; a malformed
  `lead_id` is ignored rather than erroring.

Test runner is Vitest; the component test needs the jsdom environment.

## Non-goals

Each of these was considered and deliberately cut.

- **Auto-closing tasks on matching lead activity.** A mis-mapped activity
  silently destroys real work, and there is no reliable mapping from "an
  outbound SMS was sent" to "*this specific* task is done".
- **Reassignment and field editing from the lead page.** The PATCH route accepts
  an action enum, not field edits. Adding a general update path is a larger
  surface than this problem needs; `/tasks` remains the place to restructure a
  task.
- **A cron job flagging possibly-moot tasks queue-wide.** The flag is derived at
  render time for free. A job would add a cron surface and a stored field that
  can go stale, to serve leads nobody opened.
- **Surfacing `reviewed_at` on the `/tasks` queue.** Genuinely valuable — it
  would let the queue sort "confirmed today" below "untouched for 12 days" — but
  it is a separate change to a separate page. This spec only creates the data
  that change would consume.

## Risks

- **Migration drift.** The column must exist in production before the API
  selects it, or the lead page's task query fails. Deploy order: migration
  first, then code.
- **`lead-detail.tsx` growth.** The file is at 764 lines. The card must stay a
  separate component; inlining its state machine would push the file past the
  point where it can be edited reliably.
- **Flag noise on busy leads.** A lead contacted daily will flag its tasks daily
  until a rep confirms them. This is the intended behaviour — a task on a lead
  being actively worked genuinely is the one most likely to be moot — but if it
  proves noisy, the mitigation is a minimum age on condition 1, not removing the
  flag.
