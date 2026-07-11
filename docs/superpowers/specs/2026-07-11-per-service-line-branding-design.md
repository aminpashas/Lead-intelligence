# Per-Service-Line Branding & Brand-Aware Outreach — Design

- **Date:** 2026-07-11
- **Status:** Approved (spec reviewed 2026-07-11; Phase 4 in scope)
- **Branch:** feat/pipeline-stage-restructure
- **Org this targets first:** Dion Health / SF Dentistry (`fa64e53c-3d9b-493e-b904-59580cb3f29c`)

## Problem

Every patient-facing touch (AI voice calls, booking confirmations, reminders,
campaign copy) brands off a single value — `organizations.name`. But this
practice operates **three brands (DBAs) out of one physical office**, and which
brand a lead should hear depends on what they came in for:

| Service line | Brand name | Names Dr. Samadian? | Website |
|---|---|---|---|
| `implants` | **Dion Health** | Yes | dionhealth.com |
| `tmj`, `sleep_apnea` | **San Francisco Center for TMJ and Sleep Apnea** | Yes | tmjandsleepapneasanfrancisco.com |
| `cosmetic`, `lanap`, general / unknown (default) | **SF Dentistry** | No — general dentistry | sfdentistry.com |

Additionally: when an appointment is booked, the confirmation text should
include **actual logistics** (parking + BART directions) — data that does not
exist anywhere in the system today.

## Goals

1. Voice calls, booking confirmations, and reminders speak the **correct brand
   name per the lead's service line**, and name **Dr. Amin Samadian** for
   Dion Health and the TMJ/Sleep center (not for general SF Dentistry).
2. Booking confirmations include a **parking + BART logistics block**.
3. Branding is entered/edited via a **structured Settings panel** (source of
   truth) **and** collected in the **AI onboarding interview** (writes to the
   same place).
4. A single `resolveBrand()` resolver is the one source of truth, eliminating
   the current per-channel drift.

## Non-Goals

- Separate physical locations, per-brand phone numbers / caller IDs, per-brand
  EHR location IDs. (Confirmed: one office, multiple DBAs. Shared address,
  phone, and logistics.)
- Per-*individual-campaign* brand overrides. Branding is keyed on **service
  line**, which campaigns and leads already carry.
- Migrating the live Retell voice prompt into the repo (stays dashboard-hosted;
  see Constraints).

## Constraints (shape what "live" means)

- **Messaging hard-stop is active in prod** (`MESSAGING_DRY_RUN=1`; voice off;
  reactivation paused). Nothing actually sends. Phases 2–3 are built and staged
  behind the hard-stop; live behavior is gated on lifting it separately.
- **The live voice script is a Retell-hosted LLM prompt in their dashboard**,
  not in this repo. The repo only feeds `retell_llm_dynamic_variables`. So the
  voice change is two-part: (a) plumb new variables here, (b) a **manual
  dashboard edit** to the hosted prompt to reference them. This spec delivers
  (a) plus the exact copy for (b).
- **Outbound voice currently passes no `practice_name` at all**
  (`src/lib/voice/outbound-to-lead.ts` builds vars but omits it) — so brand on
  outbound calls is net-new, not a modification.

## Approach (chosen: A — settings JSON + resolver)

Store branding in the existing `organizations.settings` bag (same pattern as
`settings.legal` / `settings.practice`) and expose one resolver that every
channel calls. No migration, no new table/RLS; branding is org config, not lead
PHI.

### Data model — `organizations.settings.branding`

```ts
settings.branding = {
  brands: {
    dion_health:  { name: "Dion Health",
                    doctorName: "Dr. Amin Samadian",
                    website: "dionhealth.com" },
    tmj_sleep:    { name: "San Francisco Center for TMJ and Sleep Apnea",
                    doctorName: "Dr. Amin Samadian",
                    website: "tmjandsleepapneasanfrancisco.com" },
    sf_dentistry: { name: "SF Dentistry",
                    doctorName: null,               // general dentistry: no provider name
                    website: "sfdentistry.com" },
  },
  serviceLineToBrand: {
    implants: "dion_health",
    tmj: "tmj_sleep",
    sleep_apnea: "tmj_sleep",
    cosmetic: "sf_dentistry",
    lanap: "sf_dentistry",
  },
  defaultBrand: "sf_dentistry",     // <-- true default is SF Dentistry (general)
  logistics: {                      // shared across all three brands (one office)
    addressText: "",                // e.g. "123 Sutter St, Suite 400, San Francisco, CA 94108"
    parkingText: "",                // e.g. "Validated parking at the Sutter-Stockton garage..."
    transitText: "",                // e.g. "BART: exit Montgomery St, 5-min walk up Sutter..."
  },
}
```

Validated with a zod schema in `src/lib/validators/` and read through a typed
accessor. Absent/partial config falls back to `organizations.name` so nothing
regresses for other orgs.

### Resolver — `resolveBrand(org, serviceLine)`

New module `src/lib/branding/resolve-brand.ts`:

```ts
resolveBrand(org, serviceLine?) => {
  practiceName: string          // brand name, or org.name fallback
  doctorName: string | null     // null → don't name a provider
  website: string | null
  logistics: { addressText, parkingText, transitText }  // shared
}
```

**Service-line → brand precedence (important subtlety).** The lead classifier
(`src/lib/leads/service-line.ts`) treats **`implants` as the residual default**
(no-niche leads classify as implants), because the ~48k historical import lost
pipeline attribution. For *branding*, that default is wrong — an unknown lead
should get **SF Dentistry (general)**, not Dion Health. So brand resolution must
use an **explicit-signal-only** service line, not the residual default:

1. If the touch is campaign-driven → use `campaigns.service_line` (explicit).
2. Else derive from the lead using **niche detection only** (explicit
   tags / UTM / `treatment_interest`): return `tmj`/`sleep_apnea`/`implants`/
   `cosmetic`/`lanap` **only on an explicit signal**.
3. No explicit signal → `defaultBrand` (SF Dentistry).

This requires a small helper `resolveBrandServiceLine(leadOrCampaign)` that,
unlike `classifyLeadServiceLines`, does **not** fall back to implants. Dion
Health is reserved for actual implant intent.

## Phase 1 — Foundation (no behavior change)

- `settings.branding` zod schema + typed getter/merger (mirror
  `src/lib/contracts/variables.ts` accessors and `practice-profile.ts` merge).
- `resolveBrand()` + `resolveBrandServiceLine()` in `src/lib/branding/`.
- **Settings panel** (`src/app/(dashboard)/settings/…`): a Branding section —
  per-brand `name` / `doctorName` / `website` fields, and the shared
  `logistics` block. Admin-gated. Writes `settings.branding`.
- **Onboarding interview**: add branding prompts to the practice interview
  (`src/lib/ai/onboarding-agent.ts` + a core-pack question group), recording
  into the **same** `settings.branding` via the profile write path. Form
  remains source of truth; interview pre-fills / updates it.
- Unit tests for the resolver (precedence, fallback, general-no-doctor).

## Phase 2 — Booking confirmation (brand-aware + logistics)

- Route the public booking confirmation SMS + email
  (`src/app/api/booking/[orgId]/book/route.ts`) through `resolveBrand()` using
  the appointment/lead service line; brand name replaces `org.name || 'Our
  Practice'`. Append the **parking/BART logistics block** to the confirmation.
- **Close the staff-booking gap**: `src/app/api/appointments/route.ts` POST
  currently sends *no* confirmation. Add the same brand-aware confirmation there
  (behind the org's existing send settings + the global hard-stop).
- Cal.com path (`src/emails/BookingConfirmation.tsx`) brand-aware for
  completeness.
- All sends stay behind `MESSAGING_DRY_RUN` — staged, not live.

## Phase 3 — Voice (inbound + outbound)

- **Inbound** (`src/app/api/voice/inbound/route.ts`): keep `practice_name`, but
  source it from `resolveBrand()` for the matched lead's service line; add new
  dynamic vars `doctor_name` and `brand_website`.
- **Outbound** (`src/lib/voice/outbound-to-lead.ts`): add `practice_name`,
  `doctor_name`, `brand_website` (all net-new here) via `resolveBrand()` keyed
  on the lead's brand service line.
- **Retell dashboard edit (manual, delivered as copy):** update the hosted
  prompt so the agent opens with, e.g.,
  *"Hi {{caller_first_name}}, this is the patient coordinator calling from
  {{practice_name}}{{#doctor_name}}, the office of {{doctor_name}}{{/doctor_name}}."*
  — naming the doctor only when the variable is present (blank for SF
  Dentistry). Exact prompt text produced in this phase; applied in the Retell
  dashboard, not deployable from code.

## Phase 4 — Reminders + email polish (optional)

- Reminder templates (`src/lib/campaigns/reminder-templates.ts`,
  `src/emails/BookingReminder.tsx`) source practice name from `resolveBrand()`
  instead of `org.name || 'our office'`; optionally surface the brand website in
  the footer for brand awareness.

## Testing

- Resolver unit tests: each service line → correct brand; unknown → SF
  Dentistry; general → `doctorName: null`; missing config → `org.name`
  fallback.
- Booking route: confirmation renders correct brand + logistics for a TMJ lead
  vs an implant lead vs a general lead (staged / dry-run assertions).
- Onboarding: interview answers land in `settings.branding` and the Settings
  form reflects them.
- Voice: dynamic-variable payload includes correct `practice_name` /
  `doctor_name` for inbound and outbound per service line.

## Rollout / sequencing

Phases are independently shippable. Suggested order: 1 → 2 → 3 → 4. Phases 2–3
land behind the existing hard-stop; going live is a separate, deliberate step
(lift `MESSAGING_DRY_RUN`, apply the Retell prompt edit).

## Open questions

- Exact `addressText`, `parkingText`, `transitText` copy for the shared office
  (owner-provided at Settings entry time — not blocking the build).
