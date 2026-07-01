# Unified Patient Channel + Intelligence — Design Spec

- **Date:** 2026-07-01
- **Branch:** `feat/full-arch-cold-reactivation`
- **Status:** Draft for review
- **Author:** Amin + Claude (brainstorming)

## 1. Summary

A single per-lead **Channel** view that merges every conversation (SMS, email, voice)
plus key activities into one chronological timeline, with an AI **Intelligence** layer on
top that produces: a rolling cross-channel summary, tone/sentiment trend, AI-assisted
notes, next-best-action, a **probability-of-closing %**, suggested **sales strategy /
techniques**, and multi-channel **follow-up sequences**. Behavior signals feed a
close-probability engine that **suggests** Kanban stage moves for one-click approval and
renders a live close-% on each pipeline card.

This is largely an **activation + assembly** effort: the unified message store, two-way
SMS/email with consent gates, the AI scoring engine, the copilot, and the drag-and-drop
Kanban already exist. The new work is the timeline UI, an AI intelligence record, a
close-probability engine, a suggest/approve stage-move flow, and follow-up sequencing.

## 2. Goals / Non-Goals

**Goals**
- One timeline per lead combining call + text + email (+ notes, appointments, stage changes).
- AI layer: summary, tone, notes, next-best-action, strategy/technique suggestions, follow-ups.
- Explainable close-probability % per lead, surfaced on the Kanban and lead detail.
- Behavior-driven stage-move **suggestions** with one-click approval (human in the loop).
- Reuse existing consent/compliance, campaigns, scoring, copilot, and org-context plumbing.

**Non-Goals (this program)**
- Building an outbound dialer / Retell AI voice agent (documented as a future upgrade).
- Automatic (no-confirmation) pipeline movement (config flag reserved, off by default).
- National DNC database integration, A/B message-variant framework (future).
- Migrating GHL conversation history (leads sync only; history stays in GHL for now).

## 3. Decisions adopted

| Decision | Choice | Rationale |
|---|---|---|
| Call capture | **Manual call logging first** | Real 3-channel feed with no telephony build; transcription is a clean later upgrade. |
| Auto-Kanban autonomy | **Suggest + one-click approve** | Matches existing draft-only-sends pattern; keeps staff in control; avoids surprising moves. |
| Close-% method | **Explainable hybrid** | Deterministic behavior features + AI adjustment, with reasons shown — trustworthy and auditable. |

## 4. Current state (verified)

- **Unified message store exists** — `conversations` (per channel) + `messages`
  (`direction`, `channel`, `sender_type`, engagement fields). `src/types/database.ts`,
  `supabase/migrations/003_conversations_and_messages.sql`.
- **Two-way SMS + email** with consent gates, compliance filters, inbound webhooks that
  persist replies, AI autopilot — `src/lib/messaging/twilio.ts`, `src/lib/messaging/resend.ts`,
  `src/app/api/webhooks/twilio/route.ts`, `src/app/api/webhooks/email-reply/route.ts`.
- **8-dimension AI scoring** → 0–100 + hot/warm/cold + per-dimension reasoning + confidence —
  `src/lib/ai/scoring.ts`.
- **Copilot** (Haiku brief + code-derived actions + Sonnet ask) — `src/lib/ai/copilot-signals.ts`,
  `src/components/crm/copilot-panel.tsx`, `src/app/api/ai/brief`, `src/app/api/ai/copilot`.
- **Kanban** with stage model + stage-change automation hook — `src/components/crm/pipeline-board.tsx`,
  `src/lib/campaigns/stage-automation.ts`.
- **Voice schema exists but unused** — `voice_calls` (transcript/recording columns),
  `supabase/migrations/20260412_voice_calling.sql`. No inbound webhook, no STT.

**Gaps this spec closes:** no timeline UI; calls not captured; no close-probability field;
no behavior-driven auto-movement; no tone analyzer / per-lead intelligence surface; no
cross-channel follow-up sequences.

## 5. Architecture

Four stacked layers, hard dependency order A → B → C → D.

### Layer A — Unified Timeline (foundation)

- **`getLeadTimeline(leadId, org)`** — new server module `src/lib/timeline/get-lead-timeline.ts`.
  Unions the lead's `messages` (all channels), `voice_calls`, and relevant `activities`
  (notes, stage changes, appointments) into a normalized, time-sorted `TimelineEntry[]`.
- **`TimelineEntry` (discriminated union)** — new type in `src/lib/timeline/types.ts`:
  ```ts
  type TimelineEntry =
    | { kind: 'message'; channel: 'sms'|'email'|'web_chat'|'whatsapp'; direction; at; body; subject?; status; ai_generated; sender_type }
    | { kind: 'call'; direction; at; outcome; duration_seconds; notes; transcript?; recording_url? }
    | { kind: 'note'; at; author; body }
    | { kind: 'stage_change'; at; from; to; by }
    | { kind: 'appointment'; at; type; status }
    | { kind: 'system'; at; body }
  ```
- **`<LeadTimeline>`** — new component `src/components/crm/lead-timeline.tsx`. Renders the
  merged feed with per-channel badges, inbound/outbound alignment, timestamps, AI-generated
  markers. Subscribes to Supabase Realtime on `messages` for live inbound updates.
- **Composer** — bottom of the timeline; reuses `lead-messaging.tsx` send paths
  (`/api/sms/send`, `/api/email/send`) and adds a **Log call** action (outcome + duration + note).
- **`<LeadDetail>` tab** — add a **Channel** (timeline) tab to `src/components/crm/lead-detail.tsx`
  (currently Overview / Activities / Notes / Financing).
- **Manual call logging** — `POST /api/leads/[id]/calls` writes a `voice_calls` row
  (`outcome`, `duration_seconds`, `notes`, `consent_verified` as appropriate). The timeline
  union surfaces it as a `call` entry. No telephony/STT in this phase.

### Layer B — AI Conversation Intelligence

- **New table `lead_intelligence`** (1:1 with leads) — single home for AI-derived state so the
  hot `leads` row does not bloat and outputs are cheap to recompute/version. Columns:
  `lead_id` (FK, unique), `organization_id`, `summary`, `tone` (e.g. frustrated/hesitant/
  interested/ready), `tone_trend` (improving/flat/declining), `objections` jsonb,
  `questions` jsonb, `commitments` jsonb, `next_action`, `strategy`, `model`, `confidence`,
  `updated_at`. RLS via `get_user_org_id()`.
- **`POST /api/ai/lead-intelligence`** — computes/refreshes the record for a lead from its
  timeline. Model tiering: **Haiku** for rolling summary + tone on each inbound (cheap, frequent);
  **Sonnet** for next-best-action + strategy on demand. Populates `conversations.sentiment`/
  `intent` (currently unset) as a side effect.
- **Intelligence sidebar** — right rail on the Channel tab showing summary, tone + trend,
  objections/commitments, next-best-action (with a one-click AI draft reply via existing
  setter/closer copilot agents), and strategy/technique suggestions.
- Reuses `src/lib/ai/summarize.ts` (extended from per-conversation to cross-channel/whole-lead)
  and the HIPAA wrapper (`scrubPHI`, `logHIPAAEvent`).

### Layer C — Close-probability % + Auto-Kanban (suggest/approve)

- **`computeCloseProbability(lead, timeline, signals)`** — new `src/lib/ai/close-probability.ts`.
  **Explainable hybrid:** deterministic feature vector (reply rate, response-latency trend,
  positive-tone share, financing readiness tier, appointment booked, recency/engagement decay,
  message volume, high-intent keywords) → weighted base score, then a bounded AI adjustment
  that returns top reasons. Output `{ probability: 0-100, band, reasons: string[] }`, stored on
  `lead_intelligence` (Phase 3 adds `close_probability`, `close_probability_band`,
  `close_probability_reasons`, `suggested_stage_id`, `suggested_at`).
- **Stage-suggestion rules** — `src/lib/pipeline/suggest-stage.ts` maps (probability band +
  behavior state) → recommended stage (e.g. booked consult → "Consultation Scheduled";
  high prob + engaged + uncontacted → "Qualified"; cold 14d → "Dormant"). Deterministic + auditable.
- **Suggest/approve flow** — suggestions appear as (1) a copilot action and (2) a badge/pip on the
  Kanban card ("Move to Qualified — 78%, replied twice + viewed financing"). One click applies the
  move via existing `onLeadStageChanged` in `stage-automation.ts`. Every suggestion + decision is
  logged in a new **`stage_suggestions`** audit table (`lead_id`, `from_stage_id`, `to_stage_id`,
  `reasons`, `status` pending/applied/dismissed, `decided_by`, `decided_at`, `organization_id`).
  A reserved org config flag can later enable "auto-move with guardrails"; default off.
- **Kanban badges** — extend `pipeline-board.tsx` cards with close-% and suggested-move pip;
  allow sort/filter by probability.
- **Recompute triggers** — on inbound message (webhook), on stage change, and a nightly cron for
  decay. Debounced, mirroring the existing debounced summarization.

### Layer D — Strategy / Technique / Follow-up Sequences

- **Technique suggestions** are part of Layer B's `strategy` output (e.g. "address cost objection
  with monthly-financing framing," "assumptive close for consult booking"), grounded in the lead's
  objections + financial tier + tone.
- **Multi-channel action plans** — generate a proposed sequence (Day 0 SMS → Day 2 email →
  Day 4 call reminder). On approval, enroll into the **existing campaigns/drip infra** rather than a
  new scheduler; exits honor `exitCampaignsOnReply`. All sends route through
  `sendSMSToLead`/`sendEmailToLead` consent gates (draft-only, human-approved).

## 6. Cross-cutting requirements

- **Consent & compliance:** all sends via existing gates (TCPA quiet hours, 10DLC gate,
  CAN-SPAM, compliance filter). Draft-only; no autonomous sends.
- **HIPAA:** every new LLM call uses `scrubPHI` + `checkResponseCompliance` + `logHIPAAEvent`.
- **Org context:** all reads/writes resolve org via `resolveActiveOrg()` (never
  `profile.organization_id`) so agency-admins managing a practice see data and can write.
- **Multi-tenant RLS:** new tables carry `organization_id` + RLS via `get_user_org_id()`.
- **Realtime:** timeline subscribes to `messages`; Kanban badges refresh on intelligence update.
- **Implementation note:** this repo runs a modified Next.js 16 — implementation MUST read the
  relevant guide under `node_modules/next/dist/docs/` before writing route/handler/component code.

## 7. Data model changes

- **Phase 2 migration** — `lead_intelligence` (1:1 leads; columns per §5 Layer B); RLS.
- **Phase 3 migration** — add probability columns to `lead_intelligence`; new `stage_suggestions`
  audit table; RLS.
- No changes to `leads`, `conversations`, or `messages` schemas (read-only consumers).

## 8. Testing strategy

- **Unit:** `getLeadTimeline` merge/ordering (interleaved channels, empty, single-channel);
  `computeCloseProbability` feature math + band thresholds (deterministic, no LLM in test);
  `suggest-stage` rule mapping.
- **Integration:** manual call logging round-trips into the timeline; inbound webhook triggers
  intelligence recompute (mock LLM); suggest→approve applies a stage move + writes an audit row.
- **Compliance:** assert every new send path passes through the consent gate; LLM calls invoke
  `scrubPHI`.
- **Follows the repo rule:** run `tsc --noEmit` before pushing to main (type errors, incl. tests,
  fail the Vercel build).

## 9. Phased roadmap (each phase independently shippable)

- **Phase 1 — Unified Timeline (Layer A):** timeline module + `<LeadTimeline>` + Channel tab +
  manual call logging + composer wiring. Ships the literal combined call/text/email view. No new AI, no migration.
- **Phase 2 — Conversation Intelligence (Layer B):** `lead_intelligence` table + rolling summary +
  tone/sentiment population + AI notes + next-best-action, surfaced in the sidebar.
- **Phase 3 — Close-% + Auto-Kanban (Layer C):** close-probability engine + stage-suggestion rules +
  Kanban badges + suggest/approve flow + `stage_suggestions` audit + recompute triggers.
- **Phase 4 — Strategy Sequences (Layer D):** technique suggestions + multi-channel follow-up plans
  enrolled via campaigns.

## 10. Risks & open questions

- **Manual call logging depends on staff discipline** — mitigated by a fast, low-friction "Log call"
  action; transcription upgrade path is documented.
- **Close-% trust** — hybrid + visible reasons; validate bands against a sample of real
  won/lost leads before enabling any auto-move.
- **LLM cost at scale** — Haiku for frequent recompute, Sonnet only on demand; debounce recompute.
- **Open:** exact stage-suggestion thresholds per practice; whether the intelligence sidebar
  replaces or augments the existing per-lead views. To be settled during Phase 1/2 implementation planning.
