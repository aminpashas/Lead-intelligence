# Conversation Notes + Call-Note Amendment — Design

**Date:** 2026-07-16
**Status:** Approved for planning

## Problem

Three asks, plus one reported bug:

1. The team needs a place to add manual notes in the conversation area.
2. They need to amend the notes on a call they missed, via right-click.
3. Notes should appear in the timeline.
4. Reported: "the timeline is not there when opening a conversation from the Leads menu."

## Investigation findings

These reshaped the work and are recorded because they contradict the original premise.

### The timeline is not missing

The Thread ⇄ Timeline segmented toggle is rendered **unconditionally** — no flag, no
role gate, no conditional — on both surfaces:

- `src/components/crm/lead-detail.tsx:225-226` (Leads → lead detail)
- `src/components/crm/conversation-view.tsx:59-61` (`/conversations/[id]`, which
  `src/app/(dashboard)/conversations/[id]/page.tsx:107` renders)

It landed in commit `9f6d3c5` on 2026-07-05. The most recent production deploy is
2026-07-16, 11 days later. **Prod has the toggle.** The stale-deploy hypothesis is
disproved.

Conclusion: this is a **discoverability failure**. The toggle is a 12px pill in the
top-right, and on the lead page it sits beside a larger, higher-contrast "Details"
button that dominates it.

### The empty-timeline bug (contributing cause)

`src/app/(dashboard)/leads/[id]/page.tsx:64-69` fetches the **50 most recent
`lead_activities` of any type**, and `buildTimeline` filters those down to
`note_added` / `stage_changed` **afterward**. There are 29 activity types. On a busy
lead, notes and stage changes are pushed out of the 50-row window before the filter
runs, so the timeline renders empty or sparse.

`/conversations/[id]/page.tsx:46-51` does not have this bug — it filters *in the
query* (`.in('activity_type', [...])`).

This is a **filter-after-limit inversion**. It plausibly explains the report: someone
clicked Timeline once on a busy lead, saw "No calls, texts, or emails yet", and
concluded the feature did not exist.

**This must be fixed regardless of the notes work** — otherwise new notes will
silently fail to appear on exactly the leads that matter most.

### Notes already have a read path with no writer

- There is **no `notes` or `lead_notes` table**, and none is needed.
- Notes are `lead_activities` rows with `activity_type = 'note_added'` — already in
  the CHECK constraint (`supabase/migrations/002_leads_and_pipeline.sql:177`).
- `build-timeline.ts:49-50` maps them to `{kind:'note'}`; `lead-timeline.tsx:253-257`
  renders them with a gold left-border.
- **Nothing in the app ever writes one.** No API route, no UI. The entire read path is
  built and unreachable.

So "add notes" is mostly a **write path into a slot that already exists**.

### Incidental findings (not in scope, logged)

- `LeadTimeline` (`lead-timeline.tsx:49`) is dead code — referenced nowhere.
- It is the only thing that mounts `LogCallDialog`, so **"Log call" has no entry point
  anywhere in the app**.
- `lead-timeline.tsx:315`: `entry.notes ?? entry.transcriptSummary` — `outcome_notes`
  **wins over** `transcript_summary`. The timeline shows one or the other, never both.
  This means editing a call's notes can silently hide its AI summary. Relevant to
  scope item 4 below.

## Decisions

| Question | Decision |
|---|---|
| Notes scope | Per-lead, shared with the whole team |
| Notes storage | Reuse `lead_activities` / `note_added`; no new table |
| Notes location | Notes block in the right-hand Insights rail |
| Note editing | Author may edit/delete own notes; all team members read all |
| Call-note amend | Edit `voice_calls.outcome_notes` in place |
| Call-note audit | Write an `audit_events` row per amendment |
| Interaction | Right-click context menu **plus** a hover `⋯` button |
| Timeline toggle | Keep both modes; increase the toggle's visual prominence |

### Why reuse `lead_activities` rather than a new table

`buildTimeline` already unions three sources into one sorted `TimelineEntry[]`. A
separate `notes` table would mean a fourth source, a fourth query on every surface,
and a new RLS policy — all to store `{lead_id, author, text, created_at}`, which is
exactly what an activity row already is.

### Why audit the call-note edits

The user's first instinct was a plain overwrite. Flagged and revised because:

- `outcome_notes` overwrites lose the prior value and the identity of the editor.
- Per the finding above, `outcome_notes` **suppresses** `transcript_summary` in the
  timeline — so an edit can silently hide the AI summary of that call.
- This repo already has an append-only `audit_events` trail; using it is ~20 lines and
  changes no UX.

## Scope

1. **Notes write path** — `POST/PATCH/DELETE /api/leads/[id]/notes`, writing
   `lead_activities` rows with `activity_type='note_added'` and `user_id` for
   attribution. RLS inherited from the table. Delete is soft, to preserve audit.
2. **Notes block in the Insights rail** — composer + author/timestamp list, inside the
   existing right-hand `<aside>` (`conversation-thread.tsx:863`). Both `/leads/[id]`
   and `/conversations/[id]` mount that panel, so both surfaces get it for free.
3. **Notes in the timeline spine** — no new rendering work. The `note` branch at
   `lead-timeline.tsx:253` is already written and currently dead; writing notes makes
   it live.
4. **Call-note amendment** — right-click *and* hover `⋯` on `CallCard` and timeline
   `CallBody` → inline editor → `PATCH voice_calls.outcome_notes` + `audit_events`
   row. Adds `@radix-ui/react-context-menu` (shadcn `context-menu`); the codebase has
   no context menu today, only `DropdownMenu`.
5. **Fix the filter-after-limit bug** at `leads/[id]/page.tsx:64` — add
   `.in('activity_type', ['note_added','stage_changed'])` to the query so the limit
   applies to the rows that survive the filter. **Blocking for item 3.**
6. **Toggle prominence** — give the Thread/Timeline pill more visual weight and stop
   the "Details" button competing with it on the lead page.

## Out of scope

- The dead `LeadTimeline` / unreachable `LogCallDialog` (logged, separate task).
- The `outcome_notes` vs `transcript_summary` precedence in the timeline (logged;
  mitigated here by the audit trail rather than fixed).
- Per-conversation or private notes.
- Any change to the thread's message rendering.

## Testing

- Unit: the notes API route (auth, org scoping, author-only edit/delete).
- Unit: extend `src/lib/__tests__/build-timeline.test.ts` — it already covers the
  `note_added` mapping at line 42 with data that production cannot currently produce.
- Regression: a lead with >50 recent non-note activities must still show its notes and
  stage changes in the timeline. This is the `.limit(50)` bug's characterization test
  and must fail before the fix.
- Manual: right-click and `⋯` both reach the call-note editor; an edit writes an
  `audit_events` row.
