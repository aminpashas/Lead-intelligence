# Campaign-Scoped AI, Playbooks & Attribution — Design

**Date:** 2026-07-11
**Status:** Approved (design) — ready for implementation planning
**Author:** Amin Samadian (w/ Claude)

## Problem

We want to start operating Lead Intelligence with a **human team using the CRM
normally** while, in the **same workspace (org)**, running **supervised AI
reactivation campaigns on cold leads** — so the AI can be proven out before it is
ever pointed at fresh/new leads. Each campaign must be able to define its own
outreach strategy, run at its own supervision level, and be audited on its own
full funnel so outcomes can be compared and tuned.

Today the CRM has the raw machinery (first-class `campaigns` + `campaign_steps` +
`campaign_enrollments`, Smart Lists, setter/closer agents, an audit trail, roles
with lead ownership) but **automation and AI behavior are global**:

- Stage-transition automations (`src/lib/funnel/automations.ts`), follow-up
  cadences (`src/lib/followup/sequence.ts`), the re-engagement ladder
  (`src/lib/nurture/ladder.ts`), and setter/closer routing
  (`src/lib/ai/agent-types.ts` `STAGE_AGENT_MAP`) are hardcoded and global.
- Autopilot enablement is **per-org** (`src/lib/autopilot/config.ts`
  `autopilot_enabled` / `autopilot_paused` / `autopilot_outreach_suppressed`).
  There is **no per-campaign or per-audience "AI on for this segment only" gate.**
- Send safety is a **global** clamp (`MESSAGING_DRY_RUN` in
  `src/lib/messaging/test-allowlist.ts`) — all-or-nothing. Lifting it to run one
  campaign makes the entire pipeline live.
- The audit trail (`src/lib/audit/`) cannot be filtered by campaign.

## Goal

Make the **campaign** the unit that carries its own AI behavior, send
authorization, and reporting, so that:

1. AI works **only** leads enrolled in an AI-enabled campaign, and **never**
   touches new/unenrolled leads.
2. Each campaign runs at its own supervision level, defaulting to review-first,
   graduating to auto per campaign.
3. Each campaign carries a **playbook** (goal, tone, hooks, guardrails) that
   shapes the AI's behavior on top of the shared setter/closer brain.
4. Every AI message and downstream outcome is attributed to its campaign,
   producing a **full funnel including revenue**.

### Decisions (locked with the user)

- **D1 — Isolation:** same workspace, campaign-scoped.
- **D2 — Supervision:** per-campaign level; new campaigns default to
  `review_first`; graduate a campaign to `auto` once trusted.
- **D3 — Strategy:** per-campaign playbook (goal + tone + hooks + guardrails)
  injected into the agent prompt; shared base setter/closer brain (no per-campaign
  forked agent).
- **D4 — Reporting:** full funnel per campaign incl. revenue, via
  enrollment-anchored **last-touch** attribution.
- **D5 — Human sends stay open:** deny-by-default applies to **AI/automation
  sends only**. Human staff continue to send SMS/email/calls freely, exactly as
  today. (The point of the exercise is that humans use the CRM normally while the
  AI runs supervised campaigns.)

### Non-goals (deferred to spec #2)

- UI authoring of per-campaign **stage-transition automation rules** (today's
  `funnel/automations.ts` stays global for now).
- Per-campaign **prequalification** configuration (today's per-org
  `financing_prequal_enabled` / `financing_auto_send_enabled` flags stay as-is).

These layer cleanly onto the scope-carrier this spec introduces.

## Approach (chosen: A — campaign-policy resolver + deny-by-default gate)

A lead's **active campaign** determines what the AI may do and whether an
automated message may send. This is computed at every AI/send surface. Rejected
alternatives: per-lead `force_on` stamping (B — fragile, no native playbook/mode)
and a separate `campaign_ai_policies` table (C — more indirection than the MVP
needs; can normalize later).

The global `MESSAGING_DRY_RUN` clamp is retained **only** as an emergency kill
switch; it is no longer the isolation mechanism.

## Architecture

### 1. Data model — `campaigns` becomes the scope-carrier

Add columns to `public.campaigns` (migration), all with safe defaults so the
change is **inert until a campaign is deliberately opted in**:

| Column | Type / default | Meaning |
|---|---|---|
| `ai_enabled` | boolean, default `false` | May the AI work leads in this campaign at all? |
| `autopilot_mode` | text, default `'review_first'`, CHECK in (`review_first`,`auto`,`off`) | Per-campaign supervision (D2). |
| `send_mode` | text, default `'suppressed'`, CHECK in (`suppressed`,`live`) | Deny-by-default send authorization for automated sends. |
| `playbook` | jsonb, default `'{}'` | `{ goal, tone, hooks[], offer, guardrails[], donts[], objection_notes }` (D3). |

RLS: inherited from the existing org-scoped `campaigns` policies. Editing these
columns is gated to `agency_admin` (mirrors existing `AGENCY_OUTBOUND_PERMISSIONS`
in `src/lib/auth/permissions.ts`).

### 2. Policy resolver — one function, consulted everywhere

`src/lib/campaigns/policy.ts`:

```
resolveCampaignPolicy(supabase, lead) -> CampaignPolicy | null
```

- Reads the lead's active `campaign_enrollments` (status `active`), joins
  `campaigns`, and selects the **last-touch** enrollment if there are several
  (most recent `next_step_at` / enrollment time).
- Returns `{ campaignId, aiEnabled, autopilotMode, sendMode, playbook }`, or
  `null` when the lead is in no AI-enabled campaign.
- A `null` policy is the default-deny state: the AI does nothing new.

This is the single source of truth every gate calls; keep it small and directly
testable (one query + a pick rule).

### 3. Gate integration — deny-by-default at every AI surface

Thread `resolveCampaignPolicy` into the surfaces the exploration identified:

- **`src/lib/autopilot/speed-to-lead.ts`** (proactive first-touch): require an
  AI-enabled campaign. New leads have no campaign → speed-to-lead goes silent for
  new leads. (Proactive outreach to *cold enrolled* leads is driven by the
  campaign step executor, not speed-to-lead.)
- **`src/lib/autopilot/auto-respond.ts`** (inbound replies): a cold enrolled lead
  who replies → AI engages per campaign `autopilot_mode`; a new/unenrolled lead
  who texts in → no active AI campaign → AI stays out and the human team handles
  them. Campaign policy is layered **in addition to** the existing gates (org kill
  switch as master; medical-question safety escalation; stop-words; consent;
  TCPA) — it never bypasses them.
- **`src/lib/campaigns/nurture-executor.ts` and `src/lib/campaigns/executor.ts`**
  (sequence steps): each AI step checks `ai_enabled` + `autopilot_mode`
  (`review_first` → draft; `auto` → send). Fixed-template steps still require
  `send_mode='live'` to physically send.
- **Low-level `sendSMSToLead` / `sendEmailToLead`**
  (`src/lib/messaging/twilio.ts`, `resend.ts`): a
  `src/lib/campaigns/send-authorization.ts` → `assertCampaignSendAllowed(lead,
  context)` backstop so no stray *automated* caller can send outside an authorized
  campaign. **Human-initiated sends are exempt** (detected via the existing
  actor/`aiGenerated` flags already present at these call sites) — per D5.

### 4. Review-first approval flow

In `review_first`, the AI's drafted reply/step is stored as a **pending
approval** (`lead_id`, `campaign_id`, `channel`, drafted `body`, proposed send
context), surfaced in a review queue that reuses the existing escalation/approval
surface (`src/app/api/autopilot/escalations/` + `escalations.claimed_by`). An
admin approves → the send fires through the campaign-authorized path (the human's
approval **is** the authorization), audit stamped `ai.approved_by`. Reject →
discarded, optionally fed to the learning loop (`src/lib/ai/learning/`).
Graduating a campaign to `auto` skips this queue for that campaign only.

Implementation detail to confirm during planning: whether the pending-draft is a
new lightweight table or an extension of the existing escalation row. Prefer
reusing the escalation mechanism if it can carry a proposed draft + approve→send
action.

### 5. Attribution & full funnel (D4)

- AI outbound messages are stamped with `campaign_id` in `messages.metadata`
  (extends the pattern the broadcast path already uses in
  `src/app/api/sms/mass/route.ts`).
- Downstream outcomes (booked → showed → closed → revenue) are attributed by
  **enrollment-anchored last-touch**: an outcome event for a lead attributes to
  that lead's most-recent active enrollment (or most-recently exited within an
  attribution window).
- `src/lib/campaigns/attribution.ts` exposes the stamp helper and a
  `get_campaign_funnel(campaign_id)` query (SQL RPC or lib query) returning:
  **enrolled → delivered → replied → booked → showed → closed → revenue.**
- The readout renders on the existing `src/components/crm/campaign-analytics.tsx`.

### 6. Rollout & safety

- Deny-by-default makes the migration **inert until a campaign is opted in** —
  shipping changes nothing observable.
- `MESSAGING_DRY_RUN` remains the global emergency kill switch; the per-org
  autopilot kill switch (`/api/autopilot/kill-switch`) remains master. Campaign
  policy is an additional, narrower gate.
- **Smoke test before real leads:** point one test campaign at
  `TEST_SEND_ALLOWLIST` (an operator's own number), run it end-to-end
  (enroll → review-first draft → approve → send → funnel), then aim it at a real
  cold Smart List.

## Testing

- **Unit:** `resolveCampaignPolicy` last-touch selection; per-`autopilot_mode`
  and per-`send_mode` gate decisions; `assertCampaignSendAllowed` for
  automated-vs-human origin.
- **Critical negative test:** a **new/unenrolled lead's inbound reply produces
  zero AI action** (no draft, no send).
- **Integration:** enroll a test lead in a `live` + `auto` campaign → send
  authorized; same lead in a `review_first` campaign → draft created, not sent,
  approve → sends; funnel counts reflect the run.

## File boundaries

**New:**
- `src/lib/campaigns/policy.ts` — `resolveCampaignPolicy`
- `src/lib/campaigns/send-authorization.ts` — `assertCampaignSendAllowed`
- `src/lib/campaigns/attribution.ts` — stamp + `get_campaign_funnel`
- `src/lib/campaigns/review-queue.ts` — pending-draft create/approve/reject
- One migration under `supabase/migrations/` — `campaigns` columns (+ any
  review-draft storage)
- API routes: campaign policy update; review-approve/reject

**Touched:**
- `src/lib/autopilot/speed-to-lead.ts`, `src/lib/autopilot/auto-respond.ts`
- `src/lib/campaigns/nurture-executor.ts`, `src/lib/campaigns/executor.ts`
- `src/lib/messaging/twilio.ts`, `src/lib/messaging/resend.ts` (backstop)
- `src/components/crm/campaign-analytics.tsx` + campaign builder UI (policy
  controls)
- `src/types/database.ts` (new columns/types)

## Open questions

None blocking. The one implementation-time decision (reuse escalation row vs. new
pending-draft table, §4) is deliberately left to the plan.
