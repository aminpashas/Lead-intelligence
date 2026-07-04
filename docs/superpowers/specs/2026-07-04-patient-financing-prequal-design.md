# Patient Financing Prequalification — "Credit Karma for dental" Design

**Date:** 2026-07-04
**Branch/worktree:** `feat/patient-financing-prequal` (`.claude/worktrees/patient-financing-prequal`)
**Status:** Design — awaiting user review

## Summary

Give patients a Credit Karma–style experience: a **soft credit pull** runs a
prequalification across multiple lenders and shows **which lenders approve them,
for how much, at what APR/monthly payment** — and, when no single lender covers
the full treatment, **stacks 2–3 lenders together to reach the full amount**.

This is delivered as **one shared results component** reused in two surfaces:

- **Staff-assisted** — inside the CRM lead-detail view (rep/AI runs it live on a call).
- **Patient self-service** — on the existing public `/finance/[shareToken]` page.

## Goals

- Multi-lender **soft-pull** prequalification (no credit-score impact, no FICO number displayed).
- Show a **best recommended plan** plus an expandable list of other offers the
  patient qualifies for ("best-offer + see more").
- **Stack multiple lenders** to cover a treatment total that exceeds any single
  lender's approved amount (e.g. $45k = Cherry $15k + Proceed $20k + CareCredit $10k).
- **Interactively pick which lenders to proceed with** and adjust per-lender
  amounts, with **total loan amount and total monthly payment recalculating live**.
- **Checkout / proceed flow** that dispatches each chosen lender's application to
  the patient — noting most lenders send the application **link directly to the
  patient** to complete off-site (link/portal-based), not via a unified in-app submit.
- **Resumable multi-lender sessions ("pick back up")** — a durable status surface
  that both patient and staff can reopen to see per-lender progress and finish
  what's outstanding, since a stacked application spans multiple visits/days.
- Surface any **remaining gap** to route to cash / in-house / insurance.
- **Payoff acceleration coaching** — default to the longest term (lowest required
  payment), then show biweekly + extra-principal savings (no prepayment penalty),
  reusing `calculator.ts`.
- **Expanded lender roster** beyond the current 7, with link/portal-based lenders
  supported as first-class (not just API lenders).
- One results component, two surfaces (staff + patient), consistent rendering.

## Non-goals (explicitly out of scope)

- **Displaying an actual FICO/VantageScore number.** That requires a bureau /
  credit-data partner, FCRA registration, and adverse-action handling. Deferred.
  We display an internal **credit tier band** at most (A/B/C/D), never a number.
- Hard-pull credit applications / final underwriting (lenders own that after prequal).
- Building underwriting logic — lenders return prequal decisions; we orchestrate + present.
  (Note: we DO expand the lender roster — see Lender roster expansion — but via the
  existing `LenderAdapter` seam, not by building credit underwriting ourselves.)

## Current state — what we reuse (do NOT rebuild)

The multi-lender engine already exists in `src/lib/financing/`:

| Existing asset | Role in this feature |
|---|---|
| `adapters/*` (7 lenders) + `LenderAdapter.preQualify()` | Soft-pull prequal per lender |
| `lender-profiles.ts` — `buildOptimalWaterfallOrder()`, per-lender FICO floors & approval-rate tables by tier | Ranking + tier-aware ordering |
| `POST /api/financing/estimate` | Parallel "as low as $X/mo" lookup across active lenders |
| `POST /api/financing/apply` — `executeWaterfall()` | Current stop-at-first-approval flow (kept as fallback) |
| `POST /api/financing/send-link` + share-token model | Patient link issuance (24h expiry, single submission) |
| `/finance/[shareToken]/page.tsx` + `financing-application-form.tsx` (`ResultScreen`) | Public page + form; `ResultScreen` gets replaced by shared component |
| `financing-waterfall-tracker.tsx`, `lead-financing-card.tsx` | Staff-side panels; gain the shared results component |
| `ai/financial-coach.ts` — `buildBudgetPlan()`, funding-sources model | Where the gap after stacking is reconciled (insurance/HSA/savings/in-house) |
| `ai/financial-qualifier.ts` — A/B/C/D tier | Optional friendly "standing" indicator |
| `contracts/*` consent capture pattern | Model for the soft-pull authorization checkbox |

## Architecture

Three new pieces sit on top of the existing engine.

### 1. Collect-all-offers mode (small engine change)

`executeWaterfall()` today stops at the first lender that approves the **full**
requested amount. We add a **collect-all** mode that runs `preQualify()` across
**all active lenders in parallel** and persists **every** result — approved
amount, APR, term, promo flag, or declined — rather than stopping at the first
yes. The existing stop-at-first waterfall remains as a selectable fallback.

- New/extended endpoint behavior: `POST /api/financing/prequal` (or a `mode`
  flag on `apply`) returns the full set of `LenderPrequalOffer` records.
- Each lender failure is isolated (already the pattern in `estimate/route.ts`) —
  a broken lender logs and is marked `error`, never silently hidden.

### 2. Stacking allocator (the genuinely new logic — pure function)

A pure, I/O-free function:

```
allocateCoverage(treatmentTotal, offers[], strategy) -> CoveragePlan {
  lines: Array<{ lender_slug, amount, apr, term_months, promo_period_months, monthly_payment, is_promo }>,
  total_loan: number, total_monthly: number,
  gap: number,                    // treatmentTotal - total_loan, routed to cash/in-house
  strategy: StackingStrategy,
}
```

Given the treatment total and each lender's approved amount, it returns a
**combination** that covers the total (or gets as close as possible), plus the
remaining gap. It lives on the pure side of the codebase seam (alongside
`lender-profiles.ts`), so it is unit-testable with fake offers and no network.
**IMPLEMENTED (Plan 1):** `src/lib/financing/allocate-coverage.ts`.

**Multiple terms per lender.** Each `LenderPrequalOffer` carries a `terms[]`
array (e.g. Cherry: 0%/12mo OR 9.99%/24mo OR 14.9%/60mo) — lenders offer several,
each a different monthly payment. `CoverageLine` records the chosen term. The
recommended plan defaults each included lender to its **lowest-monthly term**
(`pickAffordableTerm`, most affordable); the patient can override the term per
lender in the UI (Plan 2/3).

**Stacking strategy (DECIDED per owner):**

- `maximize_coverage` **(default)** — **highest approved amount first**, cheaper
  cost only a tiebreaker. Covering the big number with the fewest lenders is the
  priority: a 0% lender that only covers $6k must NOT outrank a $30k approval.
- `minimize_apr` — cheapest money first (promo/0% then ascending APR), larger
  approval as tiebreaker. Kept as a selectable alternative.

(The earlier `minimize_lenders` / `maximize_certainty` were dropped —
`maximize_coverage` already expresses largest-first. The strategy comparator
lives in `orderOffersForStrategy`; refine to taste, the tests pin behavior.)

### 3. Shared `PrequalResults` component

One React component that renders the approved design (see mockup in session):
coverage bar → recommended stacked plan (2px accent border) → est. blended
monthly → "other offers you qualify for" (approved amounts + declined, muted).

Consumed by:

- **Staff:** lead-detail panel, beside `financing-waterfall-tracker.tsx`. Data
  source: authenticated live call to the collect-all endpoint.
- **Patient:** public `/finance/[shareToken]` page — replaces the single-result
  `ResultScreen` in `financing-application-form.tsx`. Data source: share-token
  fetch. Adds the soft-pull consent checkbox + "won't affect your credit score" copy.

Surfaces differ only in **data source** and **consent chrome**, not rendering.

### 4. Interactive selection + live totals (pure)

`PrequalResults` is **interactive**, not static. Each approved offer has a
toggle; each selected lender carries a **requested amount** (defaulting to the
allocator's pick, editable up to that lender's approved cap) **and a chosen
term** (defaulting to the lowest-monthly term, switchable among the lender's
`terms[]`). A pure `computeSelectionTotals(selections, treatmentTotal)`
recalculates on every change. **IMPLEMENTED (Plan 1):**
`src/lib/financing/selection-totals.ts`.

```
computeSelectionTotals(selections, treatmentTotal) -> SelectionTotals {
  total_loan: number,       // sum of selected requested amounts (clamped to approved cap)
  total_monthly: number,    // sum of selected lenders' monthly payments for chosen terms
  covered: number,          // min(total_loan, treatmentTotal)
  gap: number,              // max(0, treatmentTotal - total_loan)
  selected_count: number,
}
```

The allocator's recommended plan is just the **default selection** — staff or
patient can override which lenders, how much from each, **and which term**. Same
behavior on both surfaces. Client-side pure math (no network) for instant feedback.

### 5. Checkout + resumable orchestration ("pick back up")

Because most lenders send their **application link directly to the patient** and
each is completed off-site over multiple visits/days, checkout is **not** a
single payment. The chosen plan is modeled as a **Financing Checkout Session**:
one parent record + **N per-lender sub-applications**, each a small state machine:

```
selected -> link_sent -> started -> approved -> funded
                                  \-> declined
                                  \-> expired
```

**Checkout action:** for each selected lender — API lenders submit directly
(`submitApplication()`); link/portal lenders dispatch their application link to
the patient (`generateApplicationUrl()` — already on the adapter interface),
sent via the patient's preferred channel.

**Resume surface (the "pick back up"):** a durable **Checkout Status page** with
a **reusable** share token (unlike today's 24h single-use link) that both patient
and staff can reopen anytime. It shows per-lender progress and what's left, e.g.
*"Cherry ✅ funded $15k · Proceed ⏳ link sent — finish it · CareCredit ◻️ not started."*

**Reconciliation — how a sub-application advances** (per the practice's actual
workflow: lender dashboard + sometimes email + patient tells us — i.e. *not*
reliably programmatic). Primary signals are manual; automation is a bonus:

1. **One-tap staff confirmation** (PRIMARY) — from lead detail, a rep marks a
   lender `approved`/`funded` (with amount) after seeing it in the lender's
   dashboard or email. This is the workhorse.
2. **Patient self-report** (SECONDARY) — the resume page lets the patient say
   "I finished this one" / upload approval; staff verifies before it counts as funded.
3. **API webhook / polling** (BONUS, where supported) — `verifyWebhook()` /
   `checkStatus()` auto-advance for the few lenders with a real API.
4. **Automated reminders + outstanding dashboard** — nudge incomplete
   sub-applications (reuse reminder/nurture infra) and give staff a clear
   "what's outstanding across all patients" view so nothing stalls silently.

**Completion:** when funded amounts ≥ treatment total, the session is complete →
hand to the closing/contract workflow. Residual gap routes to cash / in-house /
insurance via the existing `buildBudgetPlan()`.

### 6. Payoff acceleration coaching (presentation — reuses `calculator.ts`)

The practice's coaching rule: **take the longest term** (lowest *required*
monthly = maximum flexibility), then — because these loans have **no prepayment
penalty** — **accelerate voluntarily** (extra principal each month + weekly/
biweekly payments) to cut total interest and finish years early. This is why the
recommended-plan default term is the **longest** (`pickAffordableTerm`,
implemented Plan 1), not the cheapest-cost term.

This is a **presentation layer, not new math** — `src/lib/financing/calculator.ts`
already computes it: `calculateBiweeklyDetails` (biweekly payment, interest
saved, months saved) and `calculateExtraPaymentSavings` (+$50/$100/$200
scenarios), plus `generateSavingsTips`. In Plan 2/3, `PrequalResults` shows, per
the chosen plan, a "pay it off faster" panel: *"On the 84-mo plan your required
payment is $X. Pay biweekly + $100 extra → save $Y interest, done in Z months."*

Guard: only surface acceleration where the term is penalty-free. All current
lenders are (per practice); if a future lender charges a prepayment penalty, add
a `prepayment_penalty` flag to `LenderTermOption` and hide the panel for it.

## Data flow

**Patient self-service**
1. Readiness gate fires (existing) → `send-link` issues share token → SMS/email.
2. Patient opens `/finance/[shareToken]`, enters applicant data, checks soft-pull consent.
3. Collect-all prequal runs across active lenders (parallel `preQualify()`).
4. `allocateCoverage()` builds the stacked plan + gap.
5. `PrequalResults` renders offers + recommended plan; gap shown as "remaining, discuss with office".

**Staff-assisted**
1. Rep opens lead detail → "Run prequalification" (uses lead's known amount / treatment total).
2. Same collect-all + allocator path (authenticated).
3. `PrequalResults` renders inline; result persists to the lead's financing record
   and lead-activity log (reuse `describeWaterfallStrategy()` style logging).

## Lender roster expansion

Current adapters (7): CareCredit, Sunbit, Affirm, Cherry, Proceed, LendingClub, Alphaeon.

**Key findings from research (2025–2026; ownership/caps in this segment change
often — re-confirm with each lender before wiring):**

- The lenders patients recognize and that fund large full-arch cases (CareCredit,
  Cherry, Proceed) are mostly **partner-gated or portal-only** — so link/portal
  lenders must be first-class and the resumable checkout is the correct model.
- The **fastest route to "all the lenders" is an aggregator**: one API that
  waterfalls 30+ lenders prime→subprime. This is the recommended primary rail.
- A handful of **direct lenders publish real, documented APIs** (HFD, Denefits,
  PowerPay) — better integration targets than most brand-name lenders.

### Integration strategy — DECIDED: aggregator-first hybrid

The existing `LenderAdapter` interface is the right seam. An **aggregator adapter**
implements the same interface but fans out to many lenders via one integration;
the stacking/coverage UX consumes offers regardless of source.

**Chosen approach:** integrate **one aggregator (Versatile Credit / ChargeAfter /
FinMkt) as the primary rail** (30+ lenders prime→subprime through one API), plus
**a few direct-API lenders** for brands patients ask for (HFD, Denefits, PowerPay,
CareCredit), plus **portal lenders** (Proceed) via the reconciliation path.
Aggregator selection (which of the three) is a procurement task for the
implementation plan; all three implement behind the same adapter seam, so the
choice does not change the app architecture.

### Tier 1 — API aggregators (one integration → many lenders) — recommended primary

| Platform | Integration | Note |
|---|---|---|
| **Versatile Credit** | Confirmed API/embedded; **Synchrony-owned (Oct 2025)** | 30+ lenders incl. subprime (Covered Care); healthcare/dental |
| **ChargeAfter** | Confirmed API/SDK, white-label | Configurable primary/secondary/tertiary waterfall |
| **FinMkt** | Confirmed embedded/white-label | Single app, one soft pull, prime→subprime; dental vertical |
| **FormPiper** | Waterfall; **API unverified** | 6-tier routing incl. in-house/LTO; confirm API before targeting |

### Tier 2 — direct lenders with real/documented APIs

| Lender | Integration | Fit |
|---|---|---|
| **HFD** | **Documented API (OpenAPI: Origination + Easy)** | All tiers, soft-pull, ~$35k — most integration-ready |
| **Denefits** | **Documented REST API** | **No-credit-check** safety net; provider-set cap |
| **PowerPay** | Open API (docs thin) | Prime/near-prime, soft-pull, up to **$60k** — best large-case API |
| **Affirm** *(have)* | Public self-serve API | Checkout-shaped, dental ~$17.5–30k, healthcare caveats |
| **LendingUSA** | Merchant API (partner-gated) | Up to ~$47.5k, FICO ~620+ |
| **CareCredit / Synchrony** *(have)* | Dev portal (QuickScreen prequal), gated | Prime; must-have coverage; ~$25k revolving |
| **Sunbit** *(have)* | Dev portal + proven PMS integrations | Broad approval, soft-pull, **$20k cap** (mid-ticket) |
| **Cherry** *(have)* | Partner API (BD-gated), soft-pull | Broad credit, up to ~$65k (per-patient varies) |
| **Wisetack** | Partner API, soft-pull | ~$25k (FICO ~540 reach); $65k tier rolling out |
| **PatientFi** | Enterprise/partner API (no public docs) | Waterfall/no-hard-check, up to ~$50–60k |

### Tier 3 — portal/link-only (staff/patient reconciliation path)

- **Proceed Finance** *(have)* — top **product** for full-arch (loans to ~$55–75k, Optum Bank), but portal-only.
- **Alphaeon** *(have)* — Comenity/Bread-issued card, ~$25k; portal.
- **iCreditWorks** — near-prime→subprime, ~$25k; portal. *("iCredit" is ambiguous — confirm the exact vendor: iCreditWorks vs iCare vs Fortiva.)*
- **United Credit** (formerly United Medical Credit) — broker/aggregator incl. subprime, ~$35k cap; portal handoff.
- **Scratchpay** — small-ticket (~$10k), vet-centric; **too small for full-arch** — likely skip.

### Do NOT target without re-verifying (discontinued / changed / sunsetting)

- **Wells Fargo Health Advantage** — signals of **discontinuation ~12/15/2025**; verify before any effort.
- **Prosper Healthcare Lending** — branded provider program deprecated.
- **Ally Lending / Health Credit Services** — exited POS; **absorbed into Synchrony** (target Synchrony/CareCredit instead).
- **Alphaeon** — still issuing but issuer changed (Comenity/Bread) — re-confirm.
- **GreenSky** — Sixth Street-owned; dental focus diminished.
- **LendingClub Patient Solutions** — **CORRECTION: appears still operating** (~$65k, in our adapter list). Keep; do not remove.

Each new adapter implements the existing `LenderAdapter` interface. Link/portal
lenders implement `generateApplicationUrl()` (+ webhook if available) and rely on
the staff/patient reconciliation path rather than API status.

## Data model changes

- Persist per-lender prequal offers (extend `financing_submissions` or a new
  `financing_prequal_offers` table keyed by application): `lender_slug`,
  `approved_amount`, `apr`, `term_months`, `monthly_payment`, `is_promo`,
  `decision` (`approved`/`declined`/`error`).
- Persist the chosen coverage plan on the application: `coverage_plan` (jsonb),
  `total_covered`, `coverage_gap`, `blended_monthly`, `stacking_strategy`.
- Record the soft-pull authorization consent (reuse contract consent pattern).
- **Checkout session** on the application: chosen plan, per-lender selection +
  `requested_amount`, `total_loan`, `total_monthly`, `coverage_gap`,
  `session_status`, and a **reusable resume token** (multi-visit, longer TTL than
  the 24h prequal link) with its own expiry/revocation.
- **Per-lender sub-application state**: extend `financing_submissions` with the
  `selected → link_sent → started → approved → funded/declined/expired` machine,
  `funded_amount`, `confirmed_by` (staff/patient/webhook), `confirmed_at`.

Exact table vs. column choice finalized in the implementation plan after reading
the current `financing_applications` / `financing_submissions` schema.

## Consent & compliance

- Explicit **soft-pull authorization** checkbox on the public page; store consent
  record (who/when/text-hash), mirroring the contract consent capture.
- Clear "**soft check — won't affect your credit score**" language.
- **No FICO number** displayed → no FCRA adverse-action / bureau-reseller
  obligation for this scope. If real-score display is added later, it becomes a
  separate spec with its own compliance workstream.
- PII (applicant data) continues to use the existing encryption path
  (`applicant_data_encrypted`).

## Testing

- **Unit (pure):** `allocateCoverage()` — full coverage, partial coverage + gap,
  single-lender-sufficient, zero-offers, each strategy's ordering, promo-first
  behavior, rounding of blended monthly.
- **Integration:** collect-all endpoint returns all offers incl. a simulated
  lender error (isolated, not hidden).
- **Component:** `PrequalResults` renders recommended plan, declined row (muted),
  and gap state; dark-mode safe.
- **E2E (light):** public share-token → consent → results; staff lead-detail → results.

## Scope / phases

1. **Engine:** collect-all prequal mode + persistence of per-lender offers.
2. **Allocator:** `allocateCoverage()` pure function + unit tests (user authors
   the strategy scoring in learning mode).
3. **Shared component:** `PrequalResults` with **interactive selection + live
   totals** (`computeSelectionTotals`) + **payoff-acceleration panel** (biweekly /
   extra-principal, reusing `calculator.ts`); wire into staff lead-detail.
4. **Patient surface:** replace `ResultScreen` on `/finance/[shareToken]` + consent chrome.
5. **Checkout + resume:** Checkout Session model, per-lender link dispatch,
   reusable resume token, Checkout Status page (patient + staff), one-tap staff
   confirmation, patient self-report, reminders, outstanding dashboard.
6. **Roster expansion:** add adapters for vetted lenders (link/portal-based
   first-class); see Lender roster section.
7. **Polish:** activity logging, gap → budget-plan handoff, dark-mode/QA.

## Open questions (resolve during planning)

- ~~Integration strategy: aggregator-first vs. per-lender adapters?~~ **RESOLVED:
  aggregator-first hybrid** (see Integration strategy above). Remaining sub-task:
  pick the specific aggregator (Versatile / ChargeAfter / FinMkt) during planning —
  a procurement choice that does not affect app architecture.
- New `financing_prequal_offers` table vs. extending `financing_submissions`?
- Do we run prequal against the treatment total from the clinical case, or a
  staff/patient-entered amount, or both?
- Should the "other offers" list also show non-stacked single-lender full-amount
  approvals distinctly from partial approvals used in the stack?
