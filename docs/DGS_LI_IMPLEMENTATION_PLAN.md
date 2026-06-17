# DGS ↔ Lead Intelligence — Full Implementation Plan

> Goal: a closed loop where AI agents chat **and** call DGS/GHL patients (inbound + ongoing),
> prequalify + walk them through financing, score lead quality, follow up creatively when they
> ghost, model competition/negotiation, and track KPIs against org goals.
>
> Status legend: ✅ exists · 🟡 partial · 🔴 missing/blocked. Source of truth = the adversarial
> audit in this repo's session. Dates are absolute (today = 2026-06-17).

---

## Operating rules for implementers

- **Read first, then code.** Per `AGENTS.md`, this is a non-standard Next.js. Before touching route
  handlers, `after()`, crons, or caching, read the matching guide in `node_modules/next/dist/docs/`.
- **Everything ships behind a flag.** New behavior is gated by an org-level setting (default OFF) so
  we can dark-launch per org. Reuse the existing org-settings pattern (`growth_studio_webhook_config.enabled`
  is the reference for a gate that the cron fast-paths on).
- **Consent is non-negotiable.** Never weaken `src/lib/consent/gate.ts`. New send paths call
  `assertConsent()` before any Twilio/Retell/Resend call. No exceptions.
- **Multi-tenant always.** Every table carries `organization_id` + RLS via `get_user_org_id()`.
  Webhook/cron paths use `createServiceClient()` and filter org explicitly.
- **No silent failure.** Fire-and-forget is fine for non-critical side effects, but the outcome must
  land in `events`, an outbox, or ops-digest. If we drop/skip, we log why.
- **Acceptance = tests + verification.** Each phase lists acceptance criteria; land unit tests for
  pure logic and an integration check for the wired path before flipping the flag.

---

## Phase 0 — Foundations (1 week, prerequisite for everything)

These are small, cross-cutting primitives the later phases depend on.

### 0.1 Consent state model (fixes the "false ≠ unknown" problem)
- **Why:** Bridged leads arrive `sms_consent=false` by default; we can't distinguish "never asked"
  from "declined". This silently zeroes our addressable population.
- **Migration** `supabase/migrations/<ts>_consent_status.sql`:
  - Add `sms_consent_status text` and `voice_consent_status text` enums:
    `'granted' | 'declined' | 'unknown'` (default `'unknown'`).
  - Backfill: where `sms_consent = true` → `'granted'`; where an opt-out timestamp exists → `'declined'`;
    else `'unknown'`.
  - Keep existing boolean columns (the gate still reads them); the status column is for routing/UX/reporting.
- **Code:** extend `src/lib/consent/gate.ts` to treat `unknown` as "blocked, but eligible for a
  consent-capture flow" vs `declined` as "blocked, do not solicit".
- **Acceptance:** a lead with `unknown` status is excluded from outreach **and** is surfaced in a new
  "needs consent" segment; a `declined` lead never appears in any solicitation query.

### 0.2 Org feature-flag helper
- **Code:** `src/lib/org/flags.ts` — typed `getOrgFlags(orgId)` reading a `feature_flags jsonb`
  column on the orgs/settings table. Flags introduced this plan: `consent_capture`, `link_lender_tracking`,
  `lender_api_cherry`, `lender_api_alpheon`, `autonomous_reengagement`, `competitor_intel`,
  `org_goals`, `business_alerts`.
- **Acceptance:** a single source for "is X on for this org", defaulting OFF.

### 0.3 Generic scheduler heartbeat (reused by new crons)
- Confirm the existing `withCron` heartbeat wrapper (used by `reconcile-growth-studio-outbox`) is
  exported reusably; new crons in later phases register heartbeats so ops-digest can flag staleness.

---

## Phase 1 — Unblock the loop (HIGH priority, ~2 weeks)

Nothing else can contact a US patient until this lands.

### 1.1 DGS bridge must pass real consent
- **Files:** `src/app/api/v1/leads/route.ts` (LI receiver) + the DGS-side bridge that POSTs here.
- **Change (LI):** accept `sms_consent`/`voice_consent`/`email_consent` as tri-state. If a field is
  omitted, set the corresponding `*_consent_status = 'unknown'` (NOT false-as-fact). Record
  `*_consent_source` (e.g. `'dgs_form'`, `'ghl_import'`).
- **Change (DGS):** the form/bridge sends the actual checkbox state and the exact consent copy shown.
  Capture timestamp + form URL into `consent_log` for the TCPA paper trail.
- **Acceptance:** a lead submitted via DGS with the SMS checkbox ticked arrives `granted` with a
  source + timestamp; an imported GHL lead with no consent data arrives `unknown`, not `false`.

### 1.2 Consent-capture micro-flow (turns `unknown` → `granted`)
- **Why:** Most bridged leads will be `unknown`. We need a compliant way to earn consent.
- **Build:** a single-channel allowed first touch — e.g. a transactional email (Resend, which has its
  own consent basis) or a hosted opt-in page `/optin/[org]?lead=<token>` linked from existing DGS
  comms — that, when the patient confirms, flips `sms_consent_status='granted'` + writes `consent_log`.
- **Acceptance:** confirming the page/email sets status to `granted` with source `'optin_page'`; the
  lead immediately becomes eligible in outreach queries.

### 1.3 Automated 10DLC / A2P status monitoring
- **Why:** US SMS is blocked on campaign `QE2c…` (`IN_PROGRESS` after the v2 resubmit). Today it's
  polled by hand.
- **Build:** cron `src/app/api/cron/a2p-status/route.ts` (every 6h) that calls the Twilio Compliance
  API for brand + campaign status, stores it in a small `a2p_status` table, and alerts on transition
  (→ `VERIFIED` = unblock celebration; → `FAILED` = page us with the error code). Wire into ops-digest.
- **Acceptance:** when the campaign flips to `VERIFIED`, Slack gets a message and a `us_sms_enabled`
  org flag can be turned on; a regression to `FAILED` alerts within 6h with the Twilio error code.

### 1.4 Explicit voice consent (remove the silent SMS fallback)
- **File:** `src/lib/voice/call-manager.ts` (`preCallCheck`).
- **Change:** set `VOICE_REQUIRE_EXPLICIT_CONSENT=true` and stop falling back to `sms_consent`.
  Inbound calls still imply voice consent (already handled). Capture `voice_consent_source`.
- **Acceptance:** an outbound call to a lead with SMS-but-not-voice consent is blocked + logged as a
  consent violation; inbound callers are auto-granted voice consent as today.

**Phase 1 exit criteria:** with the flags on for a pilot org, an `unknown` DGS lead can be moved to
`granted` via the opt-in flow, and once 10DLC is `VERIFIED` the SMS agent completes a real two-way
US conversation end to end.

---

## Phase 2 — Financing truth (HIGH priority, ~2–3 weeks)

Make the Cherry/Alpheon story real **or** honest. Two branches — pick per partner based on whether we
have an API contract. The plan supports both; `link_lender_tracking` covers the honest-link path and is
the safe default we can ship immediately.

### 2.0 Decision gate (do this first)
- Confirm with Cherry and Alpheon whether we have **partner API access** (prequal + status webhooks).
  - Have API → do **2.A** for that lender.
  - No API → do **2.B** for that lender (and don't market it as real-time prequal).

### 2.1 Rename the heuristic so it isn't mistaken for a credit check
- **File:** `src/lib/ai/financial-qualifier.ts` + `src/components/crm/lead-financing-card.tsx`.
- **Change:** rename `tier`/`readiness` surfaces to **"Financing Signal (text-derived)"**. Change the
  DB default from `tier_c` → `NULL` and add `financial_qualification_status` enum
  `'unassessed' | 'assessed'`. UI shows "Not assessed" unless `assessed`.
- **Migration** `<ts>_financial_status.sql`: default NULL, add status column, backfill `assessed`
  where `financial_signals.last_updated IS NOT NULL`.
- **Acceptance:** an unscored bridged lead shows "Not assessed", never a fake `tier_c` grade.

### 2.A Real lender API adapters (per lender that has API access)
- **Files:** `src/lib/financing/adapters/cherry.ts`, `alpheon.ts`, `index.ts`, `waterfall.ts`.
- **Change:** implement `integrationType='api'` path: `submitApplication()` (soft prequal),
  real `getPaymentEstimate()` from lender response, and store `external_application_id`.
- **Webhooks:** `src/app/api/webhooks/financing/cherry/route.ts` + `…/alpheon/route.ts` — verify
  signature, map approval/denial/pending → `financing_applications.status`, fire the existing
  financing follow-up sequences (`src/lib/financing/follow-up.ts`).
- **Waterfall:** for API lenders, `waterfall.ts` waits for the prequal result and advances to the next
  lender on decline (the logic already exists for CareCredit/Sunbit/Affirm — extend, don't reinvent).
- **Acceptance:** a sandbox application returns a decision that lands on the lead's financing card and
  triggers the right follow-up template, with a `financing_application_events` audit row.

### 2.B Honest link-partner mode (per lender without API)
- **Files:** `src/lib/financing/waterfall.ts`, financing card, new staff UI.
- **Change:** after sending the prefilled link, set `status='link_sent'` and create a **manual outcome
  task** so staff can record approved/denied from the lender portal. Add a "record financing outcome"
  action to the lead detail.
- **Stale tracker:** cron flags `link_sent` apps with no outcome after N days → ops-digest.
- **Acceptance:** a link-lender application can be moved to approved/denied by staff; stale ones alert;
  no UI/marketing copy implies real-time API decisions.

### 2.3 Agent awareness of financing state
- **File:** `src/lib/ai/closer-agent.ts` (already consumes `financing_context`).
- **Change:** ensure the agent's `financing_context` reflects real application status (approved amount,
  monthly, denial → alternatives) so the Closer talks about the patient's actual options.
- **Acceptance:** after an approval webhook, the Closer references the approved monthly figure in its
  next message.

---

## Phase 3 — Autonomy: creative follow-up when leads ghost (MEDIUM, ~2 weeks)

The 6-stage re-close playbook exists in `closer-agent.ts` but nothing fires it on a schedule.

### 3.1 Nurture state machine + scheduler
- **Migration** `<ts>_nurture_state.sql`: `lead_nurture_state` (lead_id, current_stage,
  next_action_at, last_touch_at, attempts, paused). Reuses the existing
  `023_phase1_nurture_foundation.sql` groundwork if present.
- **Cron:** `src/app/api/cron/reengagement/route.ts` (hourly) — selects leads whose `next_action_at`
  is due, are `granted` consent, not in quiet hours, not opted out, and routes them through the
  existing Closer "re-close strategy by days since contact" (7→60d+ ladder). Respects mass-send caps
  and `autonomous_reengagement` flag.
- **Acceptance:** a lead idle 8 days with granted consent receives the stage-appropriate "value-add
  touch" automatically, honoring quiet hours and caps; opting out halts the ladder immediately.

### 3.2 Channel selection + escalation
- Prefer the channel the patient last engaged on; fall back per consent. Escalate to a human task on
  the `final_stand`/`graceful_release` stages or on detected high-intent reply.
- **Acceptance:** re-engagement picks a consented channel and creates a human escalation at the
  configured stage.

### 3.3 Effectiveness feedback loop (close the learning gap)
- Today technique effectiveness is logged but not reused. Aggregate per-org which re-engagement stages/
  techniques convert, and bias stage copy selection toward winners (still deterministic prompt
  scaffolding, just data-informed).
- **Acceptance:** a per-org report shows stage→reply/booking rates; the scheduler reads it to pick
  variants.

---

## Phase 4 — Competition & negotiation intelligence (MEDIUM, ~2–3 weeks)

Currently absent. This is genuine differentiation.

### 4.1 Competitor knowledge base
- **Migration** `<ts>_competitors.sql`: `competitors` (org_id, name, aliases, typical_pricing_notes,
  weaknesses, our_differentiators) + `lead_competitor_mentions` (lead_id, competitor_id, quote,
  detected_at).
- **Detection:** extend the inbound message pipeline (where `processFinancialSignals` runs) with a
  competitor mention extractor; populate `lead_competitor_mentions`.
- **Acceptance:** "I'm also looking at <ClinicX>" creates a mention row linked to a competitor record.

### 4.2 Competitor-aware rebuttals
- **File:** `src/lib/ai/sales-techniques.ts` + Closer prompt.
- **Change:** when a mention exists, inject the matching `our_differentiators` and price-anchoring
  guidance into the agent context so it can address the specific competitor (compliantly — no
  defamation, no fabricated claims).
- **Acceptance:** a lead who mentions a named competitor gets a response that references our concrete
  differentiators rather than a generic "send before/afters".

### 4.3 Negotiation modeling
- **File:** `src/lib/ai/patient-psychology.ts` (negotiation profile already exists).
- **Change:** add a bounded negotiation policy — approved levers (financing terms, phased treatment,
  scheduling incentives) with org-set floors, so the Closer can negotiate within guardrails instead of
  a fixed offer. No price changes outside approved bands.
- **Acceptance:** the agent proposes an approved lever when price-sensitivity is high and never
  exceeds the org's configured floor.

---

## Phase 5 — Goals & business-outcome monitoring (MEDIUM, ~2 weeks)

Agent-level KPIs are strong; org-level goals and business alerting are missing.

### 5.1 Org goals
- **Migration** `<ts>_org_goals.sql`: `org_goals` (org_id, period, metric, target_value, created_by).
  Metrics: pipeline_value, conversions, qualification_rate, revenue, bookings.
- **API + UI:** `/api/org/goals` CRUD + a goals editor; dashboard "vs target / on-pace" cards reusing
  the agent-KPI grading visuals (`src/lib/agents/grading.ts` is the reference for green/yellow/red).
- **Acceptance:** setting "Q3 pipeline target $2M" shows a live on-pace indicator on the dashboard.

### 5.2 Business-outcome alerts in ops-digest
- **File:** `src/app/api/cron/ops-digest/route.ts` (today: infra only).
- **Change:** add business checks — conversion-rate dip below warning threshold, lead-quality mix
  regression (hot share dropping), goal slippage, agents entering probation. Same Slack/Sentry sink.
- **Acceptance:** a 7-day conversion-rate drop below the configured floor produces a digest line.

### 5.3 Reporting/export
- Add CSV export for leads/KPIs and an optional scheduled weekly email digest of goal progress.
- **Acceptance:** a user can export the current leads view and opt into a Monday goals email.

---

## Phase 6 — Data quality & hardening (run alongside, ~1–2 weeks)

### 6.1 `external_ref` backfill + dedup safety
- Migration to backfill `leads.external_ref` from the `notes` `dgs_lead_id:<uuid>` regex for legacy
  rows; add an escalation when a status change has no resolvable DGS correlation id (today it silently
  skips the writeback — revenue signal vanishes).
- Add org-configurable dedup strategy (email-only / phone-only / both) to mitigate recycled-number
  collisions on phone-only leads.
- **Acceptance:** legacy leads emit writebacks; a status change with no correlation id raises an
  escalation instead of vanishing.

### 6.2 T3.3 Meta gate audit
- Alert if the DGS-owns-down-funnel gate flips state unexpectedly (prevents Meta double-counting).
- **Acceptance:** toggling the gate without an explicit org-setting change raises an alert.

### 6.3 Voice robustness
- Finish the `src/lib/voice/outbound-to-lead.ts` TODO; add Retell failure handling + post-call
  reconciliation so a dropped webhook still closes the call record.

---

## Dependency / sequencing summary

```
Phase 0 (consent model, flags, heartbeat)
   └─> Phase 1 (consent passing, opt-in, 10DLC monitor, voice consent)   [unblocks outreach]
          ├─> Phase 3 (autonomous re-engagement)                          [needs consent + scheduler]
          └─> Phase 2 (financing truth)                                   [parallel-ok after P0]
                 └─> Phase 4 (competitor + negotiation)                   [richer once financing real]
   └─> Phase 5 (org goals + business alerts)                              [parallel-ok, low coupling]
   └─> Phase 6 (data quality + hardening)                                 [continuous]
```

## Rough effort

| Phase | Theme | Est. | Priority |
|---|---|---|---|
| 0 | Foundations | 1 wk | Required |
| 1 | Unblock the loop | 2 wk | 🔴 Critical |
| 2 | Financing truth | 2–3 wk | 🔴 High |
| 3 | Autonomous follow-up | 2 wk | 🟡 Medium |
| 4 | Competition + negotiation | 2–3 wk | 🟡 Medium |
| 5 | Goals + business alerts | 2 wk | 🟡 Medium |
| 6 | Data quality + hardening | 1–2 wk | continuous |

## Open decisions (owner: Amin)
1. **Cherry/Alpheon API access?** Determines Phase 2.A vs 2.B per lender.
2. **Consent-capture channel** for `unknown` leads — transactional email vs hosted opt-in page vs both.
3. **Negotiation floors** — what levers/bands is the org willing to authorize for the agent.
4. **Pilot org** for dark-launching each phase behind flags.
