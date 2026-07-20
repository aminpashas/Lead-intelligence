# Lead Hold + Callback Plan — Design

**Date:** 2026-07-20
**Status:** Approved, not yet implemented

## Problem

There is no way to tell the system "leave this lead alone until a specific date, then
remind me to call them." Today a rep who agrees with a patient to call back on Aug 3
has no way to record that: the dialer will surface the lead again tomorrow, nurture
sequences keep texting, and the callback commitment lives only in the rep's head.

`leads.closing_follow_up_at` looks like it solves this but does not. It is coupled to
`closing_temperature = 'deliberating'`, the UI gates it to three late-funnel statuses
(`consultation_completed`, `treatment_presented`, `financing`), and it only mutes the
deal on the `/closing` board plus one task-sweep rule. It does not suppress the dialer,
campaigns, or sequences.

## Scope

A hold suppresses **all outbound automation**. Inbound is never suppressed — replies
still arrive, still create tasks, and AI may still respond to an inbound message.
Manual human outreach is never blocked, only warned.

## Data model

### `leads` columns

```sql
alter table leads
  add column hold_until  timestamptz,
  add column hold_reason text,
  add column hold_set_by uuid references auth.users(id),
  add column hold_set_at timestamptz;

create index idx_leads_hold_until
  on leads (organization_id, hold_until)
  where hold_until is not null;
```

`hold_until is null` means not on hold. This mirrors the shape of
`idx_leads_closing_follow_up_at` (`20260708130000`).

A new column rather than reuse of `closing_follow_up_at` because a hold must work on a
brand-new lead, not just a post-presentation one. The two coexist: a deliberating deal
may also be on hold, and the hold is what actually silences outbound.

### The plan is a task

Setting a hold mints one `human_tasks` row:

| field | value |
| --- | --- |
| `kind` | `callback` (new) |
| `due_at` | `hold_until` |
| `dedupe_key` | `hold:<leadId>` |
| `assigned_to` | via existing `resolveAssignee()` |
| `detail` | `hold_reason` |

One open hold = one open callback task, enforced by the existing
`human_tasks_live_dedupe_uniq` partial unique index. The task appears on `/tasks` with
everything else and is claimable/completable through the existing PATCH route.

No new reminders table. A "remind me the day before" feature, if wanted later, is a
second task row — not a schema change.

> **Migration hazard:** per the comment at `20260716140000_human_tasks_follow_up.sql:9-13`,
> every migration touching `human_tasks_kind_check` drops and recreates the full
> hardcoded kind list. Adding `callback` must replay all ten existing kinds:
> `inbound_reply, first_touch, nurture_step, stage_automation, recommendation,
> sla_breach_review, call_review, list_call, manual, follow_up`.
> The same applies to the `lead_activities` activity-type CHECK if a hold event is
> logged there.

## The choke point

The "do not contact" predicate is currently duplicated across at least six code paths.
A hold added to one leaks through the rest. All six route through one module instead:

```
src/lib/leads/hold.ts
  isOnHold(lead, now?)     -> boolean
  applyNotOnHold(query)    -> PostgREST filter for query builders
  HOLD_SELECT_COLUMNS      -> so explicit selects cannot omit the column
```

Wiring:

| Path | Location | Change |
| --- | --- | --- |
| Dialer queue | `src/lib/voice/dialer-queue.ts` ~:107 | `applyNotOnHold` |
| Campaign dialer | `src/lib/voice/campaign-dialer.ts` ~:263 | `applyNotOnHold` |
| Pre-call gate | `src/lib/voice/call-manager.ts` ~:93 | check between `voice_opt_out` and TCPA window; add `hold_until` to the explicit select at :66-72 |
| Consent gate | `src/lib/consent/gate.ts` | new `ConsentDenyReason` member `'on_hold'` |
| Smart lists | `src/lib/campaigns/smart-list-resolver.ts` `applyCriteria` | `applyNotOnHold` |
| Send authorization | `src/lib/campaigns/send-authorization.ts` | deny automation-origin sends |

`computeEligibility` (`src/lib/campaigns/eligibility.ts:13-19`) gains an `on_hold`
bucket. Its documented invariant is that buckets sum to `total - eligible`; without a
new bucket, held leads vanish from campaign previews with no explanation.

### Automation vs. human

`send-authorization.ts` already distinguishes automation callers by the `autopilot.` and
`campaign.` prefixes. A hold denies those. A human clicking Call or Send gets a confirm
dialog — "On hold until Aug 3 — contact anyway?" — not a block. Overriding clears
nothing; the hold stays until explicitly cleared or expired.

## Expiry

No new cron. `task-sweep` already runs every 15 minutes via `batch-15m`, already loops
orgs, and already mints tasks with `due_at`. It gains one step: leads whose `hold_until`
has passed get the column cleared and a `lead_activities` row logged.

The callback task needs no touching — it becomes due on its own, because `due_at` was
the hold date all along.

Clearing on expiry rather than leaving a stale past date keeps every consumer's check to
`hold_until is null or hold_until < now()`, with no ambiguity about whether a past hold
still counts.

## UI

- **Set/clear**: a Hold control in `src/components/crm/lead-actions.tsx` next to
  `MarkDeliberating` (~:448). Dialog modeled on `src/components/crm/mark-deliberating.tsx`,
  reusing its noon-local date normalization (:77) — that exists specifically to stop UTC
  day-shift from moving the callback a day early.
- **Presets**: +3 days / +1 week / +2 weeks / +1 month / custom.
- **Visible state**: badge on the lead card, lead detail header, and leads table —
  "On hold until Aug 3". A hold that is not obvious at a glance is worse than no hold,
  because the lead goes quiet and nobody knows why.
- **Dialer**: held leads simply do not appear in the queue.

## Decisions taken

1. **Hold is lead-level, not per-channel.** One unambiguous meaning; matches the promise
   made to the patient.
2. **The callback task is the plan.** No separate reminders table.
3. **Setting a hold does not change pipeline stage.** The lead stays where it is.
   Stage-move machinery already fights with GHL reconciliation (see the
   `new-lead-age-gate` note); hold should not join that fight.

## Verification

- Unit: `isOnHold` boundary behavior — exactly-now, past, null.
- Integration: set a hold, assert the lead drops out of `fetchDialerQueue`,
  `resolveSmartListLeads`, and campaign eligibility; assert `preCallCheck` denies an
  automation caller with `'on_hold'` but not a human one.
- Manual: set a hold on a lead in dev, confirm the badge renders and the lead leaves
  the dialer queue.

## Out of scope

- Pre-callback reminders (e.g. nudge one day before).
- Bulk hold from the leads table or smart lists.
- Any change to `closing_follow_up_at` semantics.
