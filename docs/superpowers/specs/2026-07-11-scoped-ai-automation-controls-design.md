# Scoped AI Automation Controls — Design

**Date:** 2026-07-11
**Status:** Approved design, pending implementation plan
**Author:** Amin Samadian (with Claude)

## Problem

Today the AI-vs-human posture is a single global switch. The AI Control page
(`/settings/ai`, `AIControlCenter`) exposes only org-level autopilot: a kill
switch / pause, an operating mode, and global guardrails (confidence, active
hours, delays, stop words, speed-to-lead). There is no way to say "AI answers
inbound in the New Lead stage, but humans handle the Nurturing stage" or "the
Reactivation campaign is AI at 0.80 confidence, 9a–5p only."

The backend to do this already exists and is unused: the `automation_policies`
table plus the resolver in `src/lib/automation/allocation.ts` already decide
AI-vs-human ownership **scoped by campaign > stage > segment > org_default**,
keyed on interaction kind (inbound reply vs outbound touch). It has zero rows in
production and no management UI. This feature builds the UI + the small backend
glue to make that engine usable.

## Goals

- Set the AI-vs-human posture **per pipeline stage** and **per campaign**, not
  just globally.
- Per scope, control **inbound** ownership and **outbound** ownership
  separately, plus two knobs: **minimum confidence** and **active hours**.
- Make the whole funnel's posture visible at a glance.

## Non-goals (v1, YAGNI)

- Per-scope stop words, response delays, or per-scope operating mode.
- Segment / smart-list scoped rules (engine supports it; no UI yet).
- Bulk import/export of rules.
- Any change to inbound AI **voice** answering (separate, Twilio/Retell-side).

## Decisions

1. **Scoped settings** = inbound owner, outbound owner, min confidence, active
   hours. All other guardrails stay global and act as the fallback.
2. **Owner values** per cell: `AI` (owner `ai`), `Human` (owner `human` → routes
   to a human task), `Hybrid` (owner `hybrid` → AI inside active hours, human
   outside).
3. **Inbound vs outbound are independent** per scope. This maps to the existing
   policy `kinds[]`: inbound = `inbound_reply`; outbound = `speed_to_lead` +
   `follow_up`.
4. **Knob inheritance is per-field.** An empty confidence/hours cell inherits the
   org-global value. The UI renders inherited cells as "— (global)".
5. **UI = stage grid.** Pipeline stages are rows; columns are
   `Stage · Inbound · Outbound · Min confidence · Active hours`. A separate
   Campaigns block below uses the same columns, one row per active campaign. The
   existing global controls remain at the top of the page as the defaults.

## Precedence & safety (most specific wins, safety overrides all)

1. **Global kill switch / pause** (`autopilot_paused` or `!autopilot_enabled`) —
   master override. When engaged, no AI acts, regardless of any rule. This is the
   safety stop and is never overridden by a scoped rule.
2. **Per-lead override** (`leads.ai_autopilot_override`: `force_on` / `force_off`
   / `assist_only`) — most specific; wins over scoped rules. (Used today for the
   test account.)
3. **Scoped rules** — campaign, then stage (existing `SCOPE_PRECEDENCE`).
4. **Global defaults** — the org-level autopilot config.

Every send continues to pass the existing consent / TCPA quiet-hours /
compliance-filter / medical-escalation gates at the send layer, independent of
these rules. Scoped rules decide *who acts*; they never bypass a safety gate.

## Architecture

### Data model
Reuse `automation_policies` (existing columns: `scope`, `campaign_id`,
`voice_campaign_id`, `stage_id`, `smart_list_id`, `kinds[]`, `owner`, `ai_role`,
`human_schedule`, `human_first`, `human_response_sla_seconds`, `enabled`). One
grid row corresponds to one or two policy rows (inbound and outbound may differ).

**New columns (migration):**
- `confidence_threshold numeric NULL` — per-scope min confidence; NULL inherits.
- `active_hours_start smallint NULL`, `active_hours_end smallint NULL` — per-scope
  window; NULL inherits.

### Resolver changes (`src/lib/automation/allocation.ts`)
- `resolveAllocation` already returns owner + reason. Extend it to also return the
  resolved knob overrides (`confidence_threshold`, `active_hours_*`) using the
  same most-specific-policy match, each field falling back to the org default when
  NULL.

### Decision-point wiring
- `src/lib/autopilot/auto-respond.ts` (inbound) and
  `src/lib/autopilot/speed-to-lead.ts` (outbound) currently read the org-global
  `confidence_threshold` and active hours from `getAutopilotConfig`. After the
  allocation gate resolves, apply the resolved per-scope knob overrides before the
  `shouldAutoRespond` confidence/hours checks.
- No change to the ordering of existing gates; the scoped knobs only tighten or
  relax the confidence/hours thresholds for the matched scope.

### API (`/api/automation/policies`)
- `GET` — list policies for the active org (admin-gated, org-scoped via
  `resolveActiveOrg`).
- `POST` / `PATCH` / `DELETE` — upsert/delete a policy row. Zod-validated:
  `scope ∈ {campaign, stage}`, exactly one target id set for the scope,
  `kinds` non-empty, `owner ∈ {ai, human, hybrid}`, optional knobs.
- All writes append to the audit trail (existing `recordAudit`).

### UI (`src/components/crm/`)
- New `ScopedAutomationGrid` component rendered in the `AIControlCenter`
  "Controls" tab, below the global controls.
- Rows built from the org's pipeline stages (existing stages source) and active
  campaigns. Each cell is an inline editor (owner select; confidence + hours
  popovers) that PATCHes the policy and optimistically updates.
- Empty cells render "— (global)" and, when edited, create the policy row.
- Admin-only editing (mirrors the existing kill-switch admin gate); non-admins
  see read-only.

## Testing

- Unit: `allocation.ts` resolution — precedence (campaign > stage > global),
  per-field knob inheritance, inbound vs outbound kind matching, and that a
  global pause still short-circuits regardless of policy.
- Unit: API validation (scope/target/kind/owner constraints, admin gate,
  org-scoping).
- Integration: an inbound reply in a "human" stage creates a human task and does
  not auto-send; an inbound reply in an "AI" stage with a per-scope confidence of
  0.9 escalates a draft below 0.9 even though the global default is 0.65.

## Build / deploy note

The repository is being actively edited by a concurrent session and production is
deployed by manual `vercel deploy` from a working tree (no Git-integration
auto-deploy). Implementation must happen in an **isolated git worktree off
`origin/main`**, land via a normal PR, and be deployed deliberately — not from the
shared working tree.
