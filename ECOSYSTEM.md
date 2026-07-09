# Dion Suite — Ecosystem Map

> 📍 **You are here: Lead Intelligence** (`lead-intelligence`)
>
> - **This repo is:** AI lead capture, qualification & conversation intelligence.
> - **You own:** leads, the **sales/lead CRM**, conversation intelligence
>   (sentiment/intent), and lead campaigns.
> - **Do NOT build here — another app owns it:** the **support/interaction CRM** →
>   **Dion Desk**. Your voice layer (`lib/voice/voice-agent.ts`) is the **seed
>   that migrates into Dion Desk** — do not grow a second telephony/voice platform
>   here. Patient comms → Patient Engagement. Marketing / demand-gen → Growth
>   Studio (hand leads over the partner API).
> - **You integrate via:** the **READ arm** (hub reads your Supabase service-role),
>   tenant column **`organization_id`**, emitting **`lead.*`** + **`conversation.*`**.
> - **Before adding a cross-cutting feature:** check the ownership matrix below.

---

## What Dion is

Dion is a **DSO/MSO operating system** — the management company that runs an
entire group of dental/medical practices. The architecture principle is
**"federate, don't merge":** every product stays a standalone app with its own
repo, database, and deploy; a shared spine connects them through one event
contract and one operator console (the **hub**, `dion-enterprise-stack`).

Brand model = **Adobe Creative Cloud.** "Dion" is the umbrella (login, launcher,
console, billing, marketing) and the holding company; each product keeps its
**own independent brand name** and is **never** renamed "Dion X". The rule:
**Dion owns the spaces *between* products; each product owns *itself*.**

The business is sold as **AI employees + usage tokens + subscription** (not SaaS
seats). Every workflow a product owns is a surface an AI employee runs on, and
every record it owns feeds the cross-product intelligence being sold — which is
why the suite builds in-house and why **duplicating a peer's workflow is
expensive**: it splits the data and the margin the model depends on.

## How the apps connect

Two integration arms into the hub:

- **READ arm** — the hub *reads* a product directly via its **Supabase**
  (service-role key + in-code tenant scoping through `@dion/connectors`
  `ScopedReader`). RLS is bypassed by the service role, so tenant authz is
  enforced **in code** on every read. **Products are never modified.**
- **PUSH arm (federation-native)** — a product *emits* `@dion/contracts` events:
  `dion_events` outbox → Edge Function (pg_cron ~5 min) → `POST /api/bus/ingest`
  on the hub → `safeParseEvent()` re-validates against the Zod catalog → bad
  events `400` → dead-letter.

**`@dion/contracts`** is the single wire and the single source of truth on both
sides (producers validate before emitting; the hub re-validates on ingest). Hard
rule: the bus carries **IDs / references / codes / amounts only — never clinical
content or PHI** (encoded structurally in the contract).

**Shared spine packages (`@dion/*`, all in the hub monorepo):** `contracts`
(event catalog), `connectors` (READ arm), `adapters` (Publisher · OutboxForwarder
· machine-auth), `master-records` (cross-product `dion_*_id` identity + dedupe),
`identity` (`dion_session` JWT/JWKS, Dion-on-WorkOS broker), `pricing`
(`analyzePractice`, P&L/QBO, `WAGE_CARD`), `capabilities`, `ui` (design system +
shell + `SUITE_PRODUCTS`), `billing`, `desk-core`, `dental-kpis`.

## The portfolio — every app

Status: **live** (deployed, working) · **connected** (hub reads it live) ·
**beta** · **planned** (named owner, not built). Arm: **READ** / **PUSH** /
**own site** (standalone, integration pending).

| Product | id | What it does | Tenant col | Arm | Events | Stack | Status |
|---|---|---|---|---|---|---|---|
| **MedicalDentalRCM** (MDRCM) | `mdrcm` | Full front-to-back revenue cycle: eligibility, credentialing, payer enrollment, pre-auth, COB, denials, AR/ledger; clearinghouse (Stedi/Availity/DentalXchange) + PMS connectors (Dentrix/Eaglesoft/CareStack). | `practice_id` | READ | `claim.*` | Supabase, 140 routes | connected |
| **Lead Intelligence** | `lead-intelligence` | AI lead capture, qualification & conversation intelligence (sentiment/intent). Also holds the real voice layer (`lib/voice/voice-agent.ts`) — the seed that migrates into Dion Desk. | `organization_id` | READ | `lead.*`, `conversation.*` | Supabase | connected |
| **Smile Design Lab** (SDL) | `smile-design-lab` | Smile design + dental-lab marketplace: case routing to labs, lab KYC, escrow. | `practice_id` | READ | `case.*` | Supabase | connected |
| **Oralogix** | `oralogix` | Clear-aligner / TMJ / sleep-appliance **manufacturing**: diagnostic scans → prescriptions → manufacturing orders. | `doctor_id` | READ | `case.*` | Supabase | connected |
| **Growth Studio** | `dion-growth-studio` | Marketing / growth / demand-gen workspace: campaigns, inbound leads, brand mentions, attribution. | `workspace_id` | READ | `campaign.*` | Supabase | connected |
| **Workforce** | `dion-workforce` | HR · Payroll · Compliance · LMS: employees, payroll runs, credentials, compliance items. The **reference federation integrator** — emits **17/17** events. | `organization_id` | PUSH | `hr.*`, `payroll.*`, `compliance.*` | Supabase | **live** |
| **Patient Engagement** (PE) | `patient-engagement` | Unified patient comms (SMS/email/app-chat/voicemail) + commerce/loyalty + **scheduling** + treatment plans + intake. Owns the real scheduler. | `practice_id` * | PUSH | `appointment.*`, `message.*` | **WorkOS/AuthKit + Inngest** | beta |
| **Dion Desk** | `dion-desk` | Zendesk-class omnichannel contact center + ticketing: SMS/email/voice unified into tickets; CRM, SLA, escalation, transcription, follow-ups. Absorbs telephony as its voice channel. Engine in `@dion/desk-core`. | — | PUSH | `ticket.*`, `comms.*` | own repo; Twilio (planned) | live |
| **Aurea** | `aurea-health` | **Diagnosis layer** — pairs with Oralogix as diagnose → manufacture. Integration (SSO unify + event emit) still pending. | — | own site | (pending) | **next-auth + Prisma; Inngest** | live |
| **Dion Insights** | `dion-insights` | Standalone practice/DSO analytics (DentaMetrix-class): CDT/procedure-code + provider production, AR aging, recare, case-acceptance, **opportunity mining** over the whole first-party funnel; legacy-PMS history import at onboarding. Warehouse = Phase-D ClickHouse. | — | consumes bus | — | own repo | building |
| **Dion Clinical** | `dion-clinical` | In-house **EMR/PMS** — clinical system of record (odontogram, perio, exam, SOAP notes, treatment planning) + smile studio + ambient AI scribe (Dion Scribe, folded in). Refers airway/sleep/TMJ → Aurea. | — | PUSH (planned) | `clinical.*` (drafted) | own repo | planned |
| **Dion Pay** | `dion-pay` | **Patient → practice** payments: card/ACH (Stripe), memberships/subscriptions, financing (Affirm/Sunbit), auto-statements, collections/dunning + escalation, patient ledger. | — | PUSH (planned) | `payment.*`, `billing.*` | — | planned |
| **Dion Finance** | `dion-finance` | Corporate GL / AP / FP&A; consumes payroll (Workforce) + collected revenue (Dion Pay) via events. | — | PUSH (planned) | `finance.*` (drafted) | — | planned |
| **Dion Supply** | `dion-supply` | Procurement / inventory / GPO — primary DSO margin lever. | — | PUSH (planned) | `inventory.*` (drafted) | — | planned |
| **Dion Acquire** | `dion-acquire` | M&A / de-novo practice onboarding & corporate integration. | — | planned | — | — | planned |
| **Dion Agents** | `dion-agents` | AI-employee runtime — define/run/supervise agents across every product; may absorb per-product agent work. | — | planned | — | — | planned |
| **Dion Billing** | `dion-billing` | Metering + billing on the **DSO → Dion** side: tokens + AI-employee seats + subscription. (`@dion/billing` package exists.) | — | planned | metering (TBD) | — | planned |
| **Dion Admin** | `apps/admin` | Write-side control plane: onboarding intake + P&L savings analysis, product catalog/commerce, tenant provisioning + entitlements. Counterpart to the read-only console. | — | in hub | — | Next.js | planned |

\* PE `practice_id` is an unverified placeholder in the connector registry — confirm against the live schema before provisioning keys.

**Out of the suite (do not integrate):** Command Center (retiring — superseded by
the hub console), SLVN Media, Hedge Fund, Spiritual Protocol, Digital AI,
`ostad-music`. Legacy/dormant: `SmileStandard/*`, `smiles-standard/*`.

## Cross-product integration pairs (the seams that must line up)

- **Aurea ↔ Oralogix** — diagnose → manufacture (Aurea diagnoses; Oralogix
  manufactures the aligner/TMJ/sleep appliance).
- **Dion Clinical → Aurea** — general-dentistry charting refers airway/sleep/TMJ
  cases out to Aurea.
- **Smile Design Lab ↔ Oralogix** — both emit `case.*`; SDL = lab-marketplace
  restorations, Oralogix = appliance manufacturing (two distinct "case
  production" surfaces — keep them separate).
- **Growth Studio ↔ Lead Intelligence** — bidirectional partner API
  (marketing/attribution ↔ leads).
- **MDRCM → Dion Pay** — MDRCM emits post-adjudication patient responsibility;
  Dion Pay owns the single patient-facing ledger + collections. **One canonical
  balance the patient sees.**
- **Workforce → Dion Finance** and **Dion Pay → Dion Finance** — labor cost and
  collected revenue post to the corporate GL via events.
- **Lead Intelligence `voice-agent.ts` → Dion Desk** — the voice seed migrates
  into Desk's voice channel (don't grow a second voice engine in LI).
- **Dion Desk → Dion Scribe / Dion Insights** — recordings/transcripts feed the
  scribe and call-outcome analytics.
- **The funnel-join moat:** Growth Studio → Lead Intelligence → Patient
  Engagement → Dion Clinical → MDRCM → Dion Pay. This first-party
  marketing→lead→appointment→chart→claim→payment join is the differentiator
  PMS-bolt-on competitors can't compute; Dion Insights consumes it.

## Workflow ownership matrix — READ THIS BEFORE BUILDING ANYTHING CROSS-CUTTING

Each workflow has **one** system of record. If you're about to build something in
the right-hand column, **stop** — integrate with the owner via `@dion/contracts`
events + `@dion/master-records` instead of rebuilding it.

| Workflow | System of record | Everyone else |
|---|---|---|
| Identity / SSO / session | Dion-on-WorkOS broker (`@dion/identity`) | consume the token; don't roll your own auth |
| Event bus / contracts | `@dion/contracts` + hub `/api/bus/ingest` | emit & validate; don't fork the schema |
| Cross-product patient/person id | `@dion/master-records` | resolve `dion_*_id`; don't re-dedupe |
| Scheduling / calendar | **Patient Engagement** | link to it; don't build a 2nd scheduler |
| Patient comms (SMS / email / chat) | **Patient Engagement** (patient-facing) | feed it; don't add a parallel inbox |
| Voice / telephony | **Dion Desk** (LI `voice-agent.ts` is the seed) | don't add a 2nd voice engine |
| Agent / ticket workspace | **Dion Desk** | feed tickets in; don't rebuild the agent console |
| Sales / lead CRM | **Lead Intelligence** | — |
| Support / interaction CRM | **Dion Desk** | — |
| Clinical chart / EMR | **Dion Clinical** (planned) | don't store clinical records locally |
| Ambient scribe | **Dion Scribe** (in Dion Clinical) | — |
| Insurance / claim AR | **MDRCM** | — |
| Patient-facing ledger + collections | **Dion Pay** (planned) | one canonical balance; don't run a 2nd ledger |
| Corporate GL / AP / FP&A | **Dion Finance** (planned) | post via events |
| Analytics / KPIs / opportunity mining | **Dion Insights** | don't build local dashboards to sell |
| Legacy PMS import (Dentrix/Eaglesoft/OpenDental) | shared `@dion/pms-connectors` | build once, share — don't re-parse |
| Marketing / demand gen | **Growth Studio** | — |
| HR / payroll / compliance | **Dion Workforce** | — |
| Procurement / inventory | **Dion Supply** (planned) | — |

> **The one rule:** building something in the right-hand column? Stop — integrate
> with the owner via the bus + master-records instead. That is the whole point of
> this document.

---

## Regenerating this file

This is **generated documentation**, not code — no build wiring. The master copy
lives in **`dion-enterprise-stack/docs/ECOSYSTEM.md`**. The block above (from
"## What Dion is" down) is the **shared body** and must stay byte-identical in
every repo's copy; only the top "📍 You are here" header differs per repo.

To update the suite: edit the shared body in the hub master, then re-copy it into
each product repo's root `ECOSYSTEM.md` (keeping each repo's own header). Source
canon lives in the hub: `VERTICALS.md`, `BRAND.md`, `PRICING.md`,
`packages/ui/src/products.ts` (`SUITE_PRODUCTS`),
`packages/connectors/src/registry.ts` (tenant columns), `packages/contracts`
(event families). Last synced: **2026-07-07**.
