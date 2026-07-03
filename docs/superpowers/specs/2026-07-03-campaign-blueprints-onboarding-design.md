# Campaign Blueprints + AI Practice Onboarding — Design

**Date:** 2026-07-03
**Status:** Approved (interviewee model, profile shape, v1 blueprint set, and full-build scope confirmed by Amin)

## Problem

Campaign setup today is one-size-fits-all: templates in `src/lib/campaigns/templates.ts` hardcode all-on-4 implant copy, and nothing captures how a specific practice actually operates (hours, consult flow, appointment lengths, technology, pricing structure). When we launch a new service line (veneers, TMJ, sleep apnea) or onboard a new practice, the AI setter/closer improvises operational facts, and campaign copy doesn't reflect the business.

Every campaign type needs (a) a **foundational core** — a versioned blueprint of steps, discovery logic, and guardrails per service line — and (b) an **onboarding interview** — an AI chat that asks the practice about its hours, operations, appointment times, services, consult flow, technology, cost structure, and preferences, and stores the answers as a structured profile that configures the campaign at launch.

## Decisions (locked)

1. **Interviewee:** One shared flow. Practice staff can self-serve **and** agency admins can run it on a practice's behalf (via enter-practice mode / `resolveActiveOrg()`). Agency admins get a toggle that turns practice self-serve on or off per org.
2. **Profile shape:** Core profile (asked once, shared across all campaign types) + short per-service-line add-on packs. A second campaign launch only asks the delta.
3. **V1 blueprints:** implants, veneers, TMJ, sleep apnea.
4. **Scope:** full build (migration, blueprints, interview chat, launch flow) on an isolated branch, tsc-verified, PR to main.

## Architecture

Three layers, mirroring existing house patterns:

```
Blueprint (code, versioned)  +  Practice Profile (DB, per org)  →  Launched Campaign (existing campaigns tables)
        │                              ▲                                   │
        │ interview question pack      │ schema-validated extraction       │ idempotent system_key seeding
        └──────────► AI Onboarding Chat (command-chat pattern) ────────────┘
```

House rules honored: **LLM writes prose, code decides actions** (launch eligibility is a code-computed gap check, never the model's opinion); partial JSONB merge (FMR intake-bag pattern) so answers never clobber each other; idempotent campaign seeding via `metadata->>'system_key'` (post-consult-nurture pattern); `resolveActiveOrg()` everywhere, RLS via `get_user_org_id()`.

### 1. Campaign Blueprints (code, `src/lib/campaigns/blueprints/`)

One file per service line + shared types + registry:

```
src/lib/campaigns/blueprints/
  types.ts        — CampaignBlueprint, InterviewQuestion, ProfileFieldPath types
  core-pack.ts    — shared core interview pack (hours/ops, appointments, consult flow,
                    technology, cost structure, preferences)
  implants.ts, veneers.ts, tmj.ts, sleep-apnea.ts
  index.ts        — registry: getBlueprint(slug), listBlueprints()
```

A `CampaignBlueprint` contains:

- `slug`, `name`, `description`, `version` (bump when steps change; system_key embeds slug only, version recorded in metadata)
- `steps`: same shape as `campaign_steps` templates today (`channel`, `delay_minutes`, `subject`, `body_template` with `{{merge_vars}}`, `ai_personalize`, send/exit conditions)
- `targetCriteria`: default audience criteria (jsonb, same vocabulary as `campaigns.target_criteria` / SmartListCriteria)
- `interview`: `{ addOnQuestions: InterviewQuestion[] }` — service-line-specific questions layered on the core pack
- `requiredProfileFields`: dot-paths into the profile (core + add-on) that must be answered before launch — the completeness gate
- `guardrails`: pricing-integrity / "never say" rules injected into personalization and setter prompts for campaigns of this type
- `kpis`: labels for the analytics surface (reuses existing campaign stats columns; no new metrics tables in v1)

`InterviewQuestion` = `{ id, profilePath, prompt, kind: 'text'|'choice'|'boolean'|'hours'|'money', choices?, required, askIf? }`. Questions are *guidance for the agent*, not a rigid form — the agent may get three answers from one reply and records them all.

### 2. Practice Profile (DB)

New migration `2026….sql`:

```sql
create table practice_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references organizations(id) on delete cascade,
  core jsonb not null default '{}',        -- shared sections (see zod schema below)
  addons jsonb not null default '{}',      -- { "<blueprint-slug>": { ... } }
  self_serve_enabled boolean not null default false,  -- agency-controlled toggle
  last_interview_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- RLS: org members select; org members update core/addons (interview writes);
-- self_serve_enabled writable only by is_admin_role() — enforced in the API layer
-- (single UPDATE policy at the table level, column-level rule in code).

alter table campaigns add column if not exists service_line text; -- 'implants'|'veneers'|'tmj'|'sleep_apnea'|null
create index if not exists idx_campaigns_service_line on campaigns(organization_id, service_line);
```

`core` sections (zod-validated in `src/lib/validators/practice-profile.ts`):

- `hours`: weekly schedule + timezone (pre-seeded from `booking_settings` when present — never ask what we know)
- `operations`: days doctors do consults, who answers phones, same-day policy, walk-ins
- `appointments`: consult duration, types offered (in-person / virtual / phone), scheduling lead time
- `consult_flow`: what happens at a consult step-by-step, who runs it, records/imaging expectations, sedation offered
- `technology`: EHR/PMS, imaging (CBCT), financing partners, booking system
- `pricing`: consult fee, price-range text per service, financing posture, insurance stance
- `preferences`: must-mention points, never-say list, tone notes, review/testimonial links

`addons.<slug>` holds the per-service answers (e.g. TMJ: splint vs botox offerings, referral requirements; sleep: home sleep tests, DME/insurance workflow).

Writes always use **partial deep-merge** at the section level (intake-bag pattern).

### 3. AI Onboarding Interview

**Route:** `POST /api/campaigns/onboarding/chat` — body `{ service_line, messages[] }` (bounded like command-chat). Loads blueprint + profile + booking_settings + org facts; system prompt = core pack + add-on pack + already-known answers + agency_ai_rules. The model gets one tool, `record_profile_answers` (`{ core?: <partial>, addon?: <partial> }`), zod-validated server-side and deep-merged into `practice_profiles`. Response: `{ reply, profile_gaps, completeness }` where `profile_gaps` is computed by code (`getProfileGaps(blueprint, profile)` in `src/lib/campaigns/onboarding.ts`).

**Access control:** agency admins and practice admins always; non-admin practice staff only when `self_serve_enabled` (and self-serve users can interview/update the profile but not launch). All reads/writes via `resolveActiveOrg()`.

**UI:** `/campaigns/setup` — service-line cards (blueprint registry) with per-line status (profile complete? campaign already live?). Selecting a line opens a two-pane view: chat on the left, live completeness checklist (sections + unanswered required fields) on the right. Agency admins additionally see the self-serve toggle. Launch button enables when `profile_gaps` is empty.

### 4. Launch

**Route:** `POST /api/campaigns/onboarding/launch` — body `{ service_line }`, admin-only.

1. Recompute gaps server-side; 422 with the gap list if incomplete (code decides, never trusts the client).
2. Refuse if a non-archived campaign with `metadata->>'system_key' = 'blueprint:<slug>'` already exists for the org (409 with pointer to it).
3. Render steps deterministically: blueprint `body_template` merge-vars filled from profile + org (practice name, hours text, consult fee text, financing partners…). `ai_personalize` flags pass through untouched — per-lead personalization stays at send time, now with the profile + blueprint guardrails in its context.
4. Insert `campaigns` row (`status: 'draft'`, `type: 'drip'`, `service_line`, `target_criteria` from blueprint, metadata `{ system_key, blueprint_version, profile_snapshot_at }`) + `campaign_steps`. Existing campaign UI handles review/activation — launch never auto-activates.

**Prompt injection:** setter/closer/personalization prompt builders gain a `practiceProfileSummary(orgId)` block (same injection mechanism as `agency_ai_rules`), so the live AI stops improvising hours, tech, and cost answers. This applies org-wide, not only to blueprint campaigns.

## Error handling

- Tool-call extraction that fails zod → merge rejected, agent told to re-ask; user reply is never lost (transcript is client-held like command-chat; profile is the durable artifact).
- Launch races: unique partial index or advisory check on `(organization_id, system_key)` for non-archived rows.
- Missing `booking_settings` → hours section simply starts empty and gets asked.
- AI cost: interview turns logged to `ai_usage` like every other agent call.

## Testing

- Unit: profile zod schemas (merge semantics, bad-shape rejection), `getProfileGaps` per blueprint, launch step rendering (merge-var fill, idempotency key).
- Route: chat route access matrix (agency admin / practice admin / staff × toggle on/off), launch 422/409/201 paths.
- Static: `tsc --noEmit` green before push (type errors block Vercel builds on main).

## Out of scope (v1)

- DB-driven blueprint editor UI (blueprints stay in code; revisit if practice count grows)
- Auto-activation, budget/ad-spend wiring, per-blueprint analytics dashboards beyond existing campaign stats
- Migrating existing hardcoded templates onto the blueprint format (they keep working untouched)
