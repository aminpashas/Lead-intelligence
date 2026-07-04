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
- Surface any **remaining gap** to route to cash / in-house / insurance.
- One results component, two surfaces (staff + patient), consistent rendering.

## Non-goals (explicitly out of scope)

- **Displaying an actual FICO/VantageScore number.** That requires a bureau /
  credit-data partner, FCRA registration, and adverse-action handling. Deferred.
  We display an internal **credit tier band** at most (A/B/C/D), never a number.
- Hard-pull credit applications / final underwriting (lenders own that after prequal).
- New lender integrations. We use the 7 adapters that already exist.
- Building underwriting logic — lenders return prequal decisions; we orchestrate + present.

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
allocateCoverage(treatmentTotal, offers[], strategy) -> {
  plan: Array<{ lenderSlug, amount, apr, termMonths, monthlyPayment, isPromo }>,
  totalCovered: number,
  gap: number,                    // treatmentTotal - totalCovered, routed to cash/in-house
  blendedMonthly: number,
  strategy: StackingStrategy,
}
```

Given the treatment total and each lender's approved amount, it returns a
**combination** that covers the total (or gets as close as possible), plus the
remaining gap. It lives on the pure side of the codebase seam (alongside
`lender-profiles.ts`), so it is unit-testable with fake offers and no network.

**Stacking strategy is a business decision (pluggable).** Default:
**minimize blended APR** — fill with 0%-promo and cheapest money first, matching
the "recommended plan" framing. Alternative strategies to keep swappable:

- `minimize_apr` (default) — lowest total interest cost to the patient.
- `minimize_lenders` — fewest applications/accounts (simplest, fastest to close).
- `maximize_certainty` — largest, most-certain approvals first (least fall-through).

> **Learning-mode implementation note:** the per-strategy scoring/ordering
> function (~8–12 lines) is authored by the user during implementation — it
> encodes the practice's closing philosophy and lender preferences.

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

## Data model changes

- Persist per-lender prequal offers (extend `financing_submissions` or a new
  `financing_prequal_offers` table keyed by application): `lender_slug`,
  `approved_amount`, `apr`, `term_months`, `monthly_payment`, `is_promo`,
  `decision` (`approved`/`declined`/`error`).
- Persist the chosen coverage plan on the application: `coverage_plan` (jsonb),
  `total_covered`, `coverage_gap`, `blended_monthly`, `stacking_strategy`.
- Record the soft-pull authorization consent (reuse contract consent pattern).

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
3. **Shared component:** `PrequalResults` + wire into staff lead-detail.
4. **Patient surface:** replace `ResultScreen` on `/finance/[shareToken]` + consent chrome.
5. **Polish:** activity logging, gap → budget-plan handoff, dark-mode/QA.

## Open questions (resolve during planning)

- New `financing_prequal_offers` table vs. extending `financing_submissions`?
- Do we run prequal against the treatment total from the clinical case, or a
  staff/patient-entered amount, or both?
- Should the "other offers" list also show non-stacked single-lender full-amount
  approvals distinctly from partial approvals used in the stack?
