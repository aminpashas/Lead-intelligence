# Campaign Blueprints + AI Practice Onboarding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-service-line campaign blueprints (implants, veneers, TMJ, sleep apnea) launched from a practice profile that an AI chat interview fills in.

**Architecture:** Blueprints live in code (`src/lib/campaigns/blueprints/`) like existing campaign templates; the practice profile is a new org-unique table written via schema-validated partial merges (intake-bag pattern); launch seeds the existing `campaigns`/`campaign_steps` tables idempotently via `metadata->>'system_key'` (post-consult-nurture pattern). Interview chat follows the command-chat route pattern with a single `record_profile_answers` tool; launch eligibility is computed by code (`getProfileGaps`), never by the model.

**Tech Stack:** Next.js 16 App Router, Supabase (RLS via `get_user_org_id()`), zod validators, Anthropic SDK (`claude-sonnet-4-6`), vitest.

**Spec:** `docs/superpowers/specs/2026-07-03-campaign-blueprints-onboarding-design.md`

**Conventions that bind every task:**
- All routes resolve org via `resolveActiveOrg()` from `@/lib/auth/active-org` — never `profile.organization_id`.
- Own-profile reads use `getOwnProfile()` (never bare `.single()` on `user_profiles`).
- Admin gate = `isAdminRole(role)` from `@/lib/auth/permissions` (`src/lib/auth/permissions.ts:202`).
- AI usage logged with `recordAiUsage` (`src/lib/ai/usage.ts:46`), feature name `'onboarding_interview'` (add to `AiUsageFeature` union).
- Tests live in `src/lib/__tests__/*.test.ts`, runner `npx vitest run <file>`.
- Commit after each task; `npx tsc --noEmit` must be green before push (type errors block Vercel).

---

### Task 1: Migration — `practice_profiles` + `campaigns.service_line`

**Files:**
- Create: `supabase/migrations/20260703120000_practice_profiles.sql`

- [ ] **Step 1: Write migration**

```sql
-- Practice profile: structured answers from the campaign-onboarding interview.
-- One row per org. `core` = shared sections (hours, operations, appointments,
-- consult_flow, technology, pricing, preferences); `addons` = per-service-line
-- answers keyed by blueprint slug. Written only via schema-validated partial
-- merges in the API layer (see src/lib/validators/practice-profile.ts).
create table if not exists public.practice_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  core jsonb not null default '{}'::jsonb,
  addons jsonb not null default '{}'::jsonb,
  -- Agency-controlled: when false, non-admin practice staff cannot run the
  -- interview themselves (agency/admins always can). Enforced in the API layer.
  self_serve_enabled boolean not null default false,
  last_interview_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.practice_profiles enable row level security;

create policy "Users can view practice profile in their org"
  on public.practice_profiles for select
  using (organization_id = public.get_user_org_id());

create policy "Users can manage practice profile in their org"
  on public.practice_profiles for all
  using (organization_id = public.get_user_org_id());

create trigger set_practice_profiles_updated_at
  before update on public.practice_profiles
  for each row execute function public.handle_updated_at();

-- Service line a campaign belongs to ('implants' | 'veneers' | 'tmj' | 'sleep_apnea').
alter table public.campaigns add column if not exists service_line text;
create index if not exists idx_campaigns_service_line
  on public.campaigns (organization_id, service_line);
```

(Verify `handle_updated_at` exists in migration 001; if the repo instead uses per-table `update_updated_at_column`, match whichever function `booking_settings` uses.)

- [ ] **Step 2: Sanity-check SQL locally** — `supabase db lint` is not configured; instead eyeball against `013_booking_availability.sql` for trigger-function name parity.
- [ ] **Step 3: Commit** — `git add supabase/migrations/… && git commit -m "feat(onboarding): practice_profiles table + campaigns.service_line"`

**Prod application is post-merge** via `supabase db query --linked -f <file>` (never `db push`).

---

### Task 2: Profile validators + deep merge

**Files:**
- Create: `src/lib/validators/practice-profile.ts`
- Test: `src/lib/__tests__/practice-profile.test.ts`

- [ ] **Step 1: Failing tests** — merge keeps sibling keys, arrays replace (not concat), unknown keys stripped, bad shapes rejected:

```ts
import { describe, it, expect } from 'vitest'
import { profileCorePatchSchema, deepMergeProfileSection } from '@/lib/validators/practice-profile'

describe('practice profile merge', () => {
  it('merges a patch without clobbering sibling sections', () => {
    const existing = { pricing: { consult_fee_text: '$150' }, technology: { ehr: 'CareStack' } }
    const patch = { pricing: { financing_partners: ['Cherry'] } }
    const merged = deepMergeProfileSection(existing, patch)
    expect(merged.pricing).toEqual({ consult_fee_text: '$150', financing_partners: ['Cherry'] })
    expect(merged.technology).toEqual({ ehr: 'CareStack' })
  })
  it('replaces arrays wholesale', () => {
    const merged = deepMergeProfileSection(
      { preferences: { never_say: ['cheap'] } },
      { preferences: { never_say: ['discount'] } }
    )
    expect(merged.preferences.never_say).toEqual(['discount'])
  })
  it('rejects unknown sections', () => {
    expect(profileCorePatchSchema.safeParse({ nonsense: { a: 1 } }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run `npx vitest run src/lib/__tests__/practice-profile.test.ts`** — FAIL (module missing).
- [ ] **Step 3: Implement.** Sections (all optional, all partial): `hours` (`timezone`, `weekly_text`, `consult_days`), `operations` (`phone_coverage`, `same_day_policy`, `walk_ins`, `notes`), `appointments` (`consult_duration_minutes`, `types` (`in_person`/`virtual`/`phone` array), `lead_time_days`), `consult_flow` (`steps_text`, `run_by`, `imaging`, `sedation_offered`), `technology` (`ehr`, `imaging`, `financing_partners[]`, `booking_system`), `pricing` (`consult_fee_text`, `price_range_text` record by service slug, `financing_posture`, `insurance_stance`), `preferences` (`must_mention[]`, `never_say[]`, `tone_notes`, `testimonial_url`). `profileAddonPatchSchema` = `z.record(slugEnum, z.record(z.string(), z.unknown()))` narrowed per blueprint by its own addon schema (each blueprint exports one — see Task 3). `deepMergeProfileSection`: plain objects merge recursively, arrays and scalars replace, `null` deletes a key.
- [ ] **Step 4: Tests pass.**
- [ ] **Step 5: Commit** — `feat(onboarding): practice profile schemas + deep merge`

---

### Task 3: Blueprint library

**Files:**
- Create: `src/lib/campaigns/blueprints/types.ts`, `core-pack.ts`, `implants.ts`, `veneers.ts`, `tmj.ts`, `sleep-apnea.ts`, `index.ts`
- Create: `src/lib/campaigns/onboarding.ts` (`getProfileGaps`, `renderBlueprintSteps`)
- Test: `src/lib/__tests__/blueprint-onboarding.test.ts`

- [ ] **Step 1: Types.** `CampaignBlueprint` per the spec: `slug` (`'implants'|'veneers'|'tmj'|'sleep_apnea'`), `name`, `description`, `version`, `steps: BlueprintStep[]` (shape of `NurtureStepSeed` from `post-consult-nurture.ts:54` minus closer-specific metadata, plus optional `name`), `targetCriteria`, `addOnQuestions: InterviewQuestion[]`, `addonSchema: z.ZodTypeAny`, `requiredProfileFields: string[]` (dot-paths, `core.` or `addon.` prefixed), `guardrails: string[]`, `kpis: string[]`.
  `InterviewQuestion` = `{ id, profilePath, prompt, kind: 'text'|'choice'|'boolean'|'hours'|'money', choices?, required }`.
- [ ] **Step 2: Core pack** (`core-pack.ts`): ~14 questions covering every core section (hours/consult days, phone coverage, same-day policy, consult duration + types, consult flow narrative + who runs it + imaging + sedation, EHR, financing partners, consult fee, financing posture, insurance stance, must-mention, never-say, tone). Each maps to a `core.<section>.<field>` path. Export `CORE_REQUIRED_FIELDS` — the subset required for any launch.
- [ ] **Step 3: Four blueprints.** Each ~6–8 steps (SMS+email mix, day-0 → day-21 nurture arc), copy written per service line using `{{merge}}` vars from two vocabularies: per-lead vars resolved at send time by `personalize()` (`personalization.ts:97` — `{{first_name}}` etc.) and **profile vars resolved at launch** (`[[practice_name]]`, `[[consult_fee_text]]`, `[[price_range]]`, `[[financing_partners]]`, `[[hours_text]]` — square brackets so the two phases can't collide). Add-on questions per line: implants (arch focus, grafting/same-day capability, All-on-X price band), veneers (min units, smile-design workflow, price per unit band), TMJ (splint/botox/ortho offerings, referral requirement, insurance billing), sleep (home sleep tests, DME workflow, medical-insurance billing, CPAP-alternative positioning). Guardrails reuse the pricing-integrity stance (no invented dollar figures; use profile price text only).
- [ ] **Step 4: `getProfileGaps(blueprint, profile)`** — resolves each required dot-path against `{core, addon: addons[slug]}`; missing/empty → gap `{ path, question }` (question looked up from packs). `renderBlueprintSteps(blueprint, profile, org)` — fills `[[...]]` vars, throws on unresolved var.
- [ ] **Step 5: Tests** — gap list shrinks as profile fills; fully-filled profile → `[]`; rendering fills profile vars and leaves `{{first_name}}` untouched; unresolved `[[var]]` throws; every blueprint's `requiredProfileFields` all resolve to real pack questions (registry-integrity test across all four).
- [ ] **Step 6: Commit** — `feat(onboarding): campaign blueprints for implants/veneers/tmj/sleep + gap engine`

---

### Task 4: Profile data access

**Files:**
- Create: `src/lib/campaigns/practice-profile.ts`

- [ ] **Step 1: Implement:**
  - `getOrCreatePracticeProfile(supabase, orgId)` — select by org; on miss, insert `{}` row **pre-seeded** from `booking_settings` (weekly_schedule → `core.hours.weekly_text` humanized, timezone) when present; tolerate insert race by re-selecting.
  - `mergeProfileAnswers(supabase, orgId, { core?, addon?, slug? })` — validate patches (Task 2 schemas + blueprint addonSchema), deep-merge onto current row, update with `last_interview_at: now()`.
  - `practiceProfileSummary(profile)` — compact plain-text block ("PRACTICE FACTS — …") for prompt injection; empty string when profile has no content.
- [ ] **Step 2: Commit** — `feat(onboarding): practice profile data access + prompt summary`

---

### Task 5: Interview agent + chat route

**Files:**
- Create: `src/lib/ai/onboarding-agent.ts`
- Create: `src/app/api/campaigns/onboarding/chat/route.ts`
- Modify: `src/lib/ai/usage.ts:17` (add `'onboarding_interview'` to `AiUsageFeature`)

- [ ] **Step 1: Agent.** `runOnboardingInterview({ supabase, orgId, serviceLine, history, userName })`:
  - System prompt: role ("you are onboarding <practice> for the <line> campaign"), the core+addon question packs, **already-answered facts** (so it never re-asks), remaining gaps (from `getProfileGaps`), agency AI rules (`getAgencyRules` from `agency-rules.ts` — same injection as setter), style rules (one topic at a time, conversational, record everything the user reveals even if unprompted).
  - One tool `record_profile_answers` `{ core?: object, addon?: object }`; on call → `mergeProfileAnswers` (zod-gated; on validation failure return the error text as the tool result so the model re-asks). Private loop (max 4 rounds — `runAgentToolLoop` is bound to autopilot's dispatcher, so this agent owns its own small loop), model `claude-sonnet-4-6`, `recordAiUsage` on completion.
  - Returns `{ reply, gaps, completeness: { answered, required } }` — gaps recomputed from the DB after merges.
- [ ] **Step 2: Route** `POST /api/campaigns/onboarding/chat` — clone of command-chat route shape (`route.ts:20-63`): rate-limit `RATE_LIMITS.ai`, `resolveActiveOrg`, body `{ service_line: slugEnum, messages[] }` (max 60 turns), **access gate**: `isAdminRole(role)` OR profile row `self_serve_enabled` — else 403.
- [ ] **Step 3: Commit** — `feat(onboarding): AI interview agent + chat route`

---

### Task 6: Profile/settings route + launch route

**Files:**
- Create: `src/app/api/campaigns/onboarding/profile/route.ts` (GET, PATCH)
- Create: `src/app/api/campaigns/onboarding/launch/route.ts` (POST)
- Test: `src/lib/__tests__/blueprint-launch.test.ts` (pure pieces: step-row building, idempotency key)

- [ ] **Step 1: Profile route.** GET → `{ profile, self_serve_enabled, lines: [{slug, name, gaps, launched_campaign_id}] }` (per-line status for the setup page). PATCH body `{ self_serve_enabled: boolean }` — `isAdminRole` only (403 otherwise).
- [ ] **Step 2: Launch route.** POST `{ service_line }`, admin-only:
  1. `getProfileGaps` non-empty → 422 `{ gaps }`.
  2. Existing non-archived campaign where `metadata->>'system_key' = 'blueprint:<slug>'` → 409 `{ campaign_id }`.
  3. Insert campaign `status:'draft'`, `type:'drip'`, `channel:'multi'`, `service_line`, `target_criteria` from blueprint, `send_window` default business hours w/ profile timezone, metadata `{ system_key, blueprint_version, profile_snapshot_at }`; insert steps from `renderBlueprintSteps` (delete campaign row if steps insert fails — nurture-seeder pattern `post-consult-nurture.ts:266+`).
  4. Return 201 `{ campaign_id }`.
- [ ] **Step 3: Tests + commit** — `feat(onboarding): profile/toggle + blueprint launch routes`

---

### Task 7: Setup UI

**Files:**
- Create: `src/app/(dashboard)/campaigns/setup/page.tsx` (server component: auth + initial data)
- Create: `src/components/crm/campaign-setup.tsx` (client: cards + two-pane interview)

- [ ] **Step 1: Page** — fetch profile route server-side, render `<CampaignSetup lines={…} selfServe={…} isAdmin={…} isAgencyAdmin={…}/>`.
- [ ] **Step 2: Component** — service-line cards (name, description, completeness bar, "Live"/"Draft" badge when launched); selecting opens chat pane (message list + input posting to `/chat`) with checklist sidebar rendered from `gaps` in each response; Launch button (admins, enabled at 0 gaps) → POST `/launch` → link to the created draft in existing campaign UI; agency-admin-only self-serve toggle → PATCH `/profile`. Match existing dashboard styling (reuse patterns from `src/components/crm/campaign-builder.tsx` and the command-center chat component).
- [ ] **Step 3: Entry point** — add a "Campaign setup" link/button on `/campaigns` page header.
- [ ] **Step 4: Commit** — `feat(onboarding): campaign setup page with AI interview`

---

### Task 8: Profile injection into live agents

**Files:**
- Modify: `src/lib/ai/setter-agent.ts`, `src/lib/ai/closer-agent.ts` (where `agency-rules` block is injected — grep `getAgencyRules`)

- [ ] **Step 1:** Fetch profile (cheap single-row select; tolerate absence) and append `practiceProfileSummary(profile)` to the system prompt next to the agency-rules block in both agents.
- [ ] **Step 2:** `npx vitest run` (full suite — setter/closer have existing tests) + commit — `feat(onboarding): inject practice profile facts into setter/closer prompts`

---

### Task 9: Verification + PR

- [ ] `npx vitest run` — full suite green.
- [ ] `npx tsc --noEmit` — green (blocks Vercel otherwise).
- [ ] `npm run build` — green.
- [ ] Push branch, `gh pr create` to main. PR body: spec link, screenshot note, **post-merge step: apply `20260703120000_practice_profiles.sql` to prod via `supabase db query --linked -f`**. (Lint step on main CI is chronically red from pre-existing debt — not a blocker.)
