# Patient Financing Prequal — Core Math Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, unit-tested math core for multi-lender stacked financing — the `allocateCoverage()` stacking allocator and `computeSelectionTotals()` live-totals function — with zero external dependencies.

**Architecture:** Pure functions in `src/lib/financing/`, reusing the existing `generateAmortizationSchedule()` from `calculator.ts` for per-lender monthly-payment math. No I/O, no network, no React. This is the foundation the collect-all engine (Plan 2) and UI (Plan 2/3) consume.

**Tech Stack:** TypeScript, Vitest (`vitest run`), path alias `@/` → `src/`.

**Scope note:** This is Plan 1 of 3. Plan 2 = collect-all prequal engine + shared `PrequalResults` component + staff wiring. Plan 3 = patient surface + checkout/resume + aggregator adapter. This plan produces working, tested software on its own (the allocator + selection math), including the user's learning-mode contribution (the stacking-strategy ordering function).

**Spec:** `docs/superpowers/specs/2026-07-04-patient-financing-prequal-design.md`

---

## Revision (2026-07-04, post-owner-feedback) — IMPLEMENTED

The model was revised during implementation per owner feedback; the **committed
code supersedes the flat single-term code blocks shown in Tasks 1–4 below**:

- **Multiple terms per lender:** `LenderPrequalOffer` carries `terms: LenderTermOption[]`
  (not a single apr/term/promo). `CoverageLine` records the chosen term.
- **Amount-first stacking:** default strategy is `maximize_coverage` (highest
  approved amount first, cost only a tiebreaker), not `minimize_apr`. `minimize_apr`
  kept as the alternative. Strategy enum is `'maximize_coverage' | 'minimize_apr'`.
- **Default recommended term = lowest monthly** (`pickAffordableTerm`); patient
  can override per lender in the UI.
- New/changed exports: `monthlyPaymentFor`, `pickAffordableTerm`,
  `buildCoverageLine(offer, amount, term)`, `orderOffersForStrategy`,
  `allocateCoverage(total, offers, strategy='maximize_coverage')`,
  `computeSelectionTotals(selections, total)` where a selection is `{offer, amount, term}`.

Status: all four files implemented, **16 tests green, tsc clean**, committed
(`61a5e1e` supersedes the originally-planned single-term commits). The learning-mode
`orderOffersForStrategy` slot was resolved by the owner's explicit ordering rule.

## File structure

- Create `src/lib/financing/prequal-types.ts` — new types: `StackingStrategy`, `LenderPrequalOffer`, `CoverageLine`, `CoveragePlan`, `LenderSelection`, `SelectionTotals`.
- Create `src/lib/financing/coverage-line.ts` — `buildCoverageLine(offer, amount)`, the shared primitive that turns an offer + allocated principal into a `CoverageLine` (reuses `generateAmortizationSchedule`).
- Create `src/lib/financing/allocate-coverage.ts` — `orderOffersForStrategy()` (the learning-mode function) + `allocateCoverage()`.
- Create `src/lib/financing/selection-totals.ts` — `computeSelectionTotals()`.
- Create `src/lib/financing/__tests__/coverage-line.test.ts`
- Create `src/lib/financing/__tests__/allocate-coverage.test.ts`
- Create `src/lib/financing/__tests__/selection-totals.test.ts`

Each file has one responsibility; the shared `buildCoverageLine` keeps the allocator and the selection-totals function DRY (both need "amount → monthly payment").

---

## Task 1: Prequal types

**Files:**
- Create: `src/lib/financing/prequal-types.ts`

- [ ] **Step 1: Write the types file**

```typescript
import type { LenderSlug } from './types'

// How the allocator prioritizes lenders when stacking to cover a total.
export type StackingStrategy = 'minimize_apr' | 'minimize_lenders' | 'maximize_certainty'

// One lender's soft-pull prequalification result (produced by the collect-all
// engine in Plan 2; defined here because the pure math consumes it).
export type LenderPrequalOffer = {
  lender_slug: LenderSlug
  lender_name: string
  decision: 'approved' | 'declined'
  approved_amount: number       // max this lender will fund; 0 when declined
  apr: number                   // annual percentage rate, e.g. 9.9
  term_months: number
  promo_period_months: number   // 0 when no promo
}

// A single lender's contribution to covering the treatment total.
export type CoverageLine = {
  lender_slug: LenderSlug
  lender_name: string
  amount: number                // allocated principal from this lender
  apr: number
  term_months: number
  promo_period_months: number
  monthly_payment: number       // monthly payment for `amount`
  is_promo: boolean
}

// The stacked plan: which lenders cover how much, and the blended totals.
export type CoveragePlan = {
  lines: CoverageLine[]
  treatment_total: number
  total_loan: number            // sum of line amounts (<= treatment_total)
  total_monthly: number         // sum of line monthly payments
  gap: number                   // treatment_total - total_loan (routes to cash/in-house)
  strategy: StackingStrategy
}

// A user/staff selection of one lender + how much to draw from it.
export type LenderSelection = {
  offer: LenderPrequalOffer
  amount: number                // requested amount (will be clamped to approved_amount)
}

// Live totals for an arbitrary selection (drives the interactive UI).
export type SelectionTotals = {
  lines: CoverageLine[]
  total_loan: number
  total_monthly: number
  covered: number               // min(total_loan, treatment_total)
  gap: number                   // max(0, treatment_total - total_loan)
  selected_count: number
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no new errors referencing `prequal-types.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/financing/prequal-types.ts
git commit -m "feat(financing): prequal offer + coverage plan types"
```

---

## Task 2: buildCoverageLine (shared amount → monthly primitive)

**Files:**
- Create: `src/lib/financing/coverage-line.ts`
- Test: `src/lib/financing/__tests__/coverage-line.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { buildCoverageLine } from '@/lib/financing/coverage-line'
import type { LenderPrequalOffer } from '@/lib/financing/prequal-types'

const promoOffer: LenderPrequalOffer = {
  lender_slug: 'cherry',
  lender_name: 'Cherry',
  decision: 'approved',
  approved_amount: 15000,
  apr: 0,
  term_months: 12,
  promo_period_months: 12,
}

const interestOffer: LenderPrequalOffer = {
  lender_slug: 'proceed',
  lender_name: 'Proceed Finance',
  decision: 'approved',
  approved_amount: 20000,
  apr: 9.9,
  term_months: 60,
  promo_period_months: 0,
}

describe('buildCoverageLine', () => {
  it('computes an exact monthly payment for a 0% promo line (principal / term)', () => {
    const line = buildCoverageLine(promoOffer, 15000)
    expect(line.amount).toBe(15000)
    expect(line.monthly_payment).toBe(1250) // 15000 / 12
    expect(line.is_promo).toBe(true)
    expect(line.lender_slug).toBe('cherry')
  })

  it('computes an amortized monthly payment for an interest-bearing partial draw', () => {
    const line = buildCoverageLine(interestOffer, 20000)
    // 20000 @ 9.9% / 60mo standard amortization ≈ $424/mo
    expect(line.monthly_payment).toBeCloseTo(424, 0)
    expect(line.is_promo).toBe(false)
    expect(line.apr).toBe(9.9)
  })

  it('uses the allocated amount, not the approved cap', () => {
    const line = buildCoverageLine(interestOffer, 10000) // draw less than approved 20000
    expect(line.amount).toBe(10000)
    expect(line.monthly_payment).toBeCloseTo(212, 0) // half of the full-draw payment
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/financing/__tests__/coverage-line.test.ts`
Expected: FAIL — cannot resolve `@/lib/financing/coverage-line`.

- [ ] **Step 3: Write the implementation**

```typescript
import { generateAmortizationSchedule } from './calculator'
import type { LenderPrequalOffer, CoverageLine } from './prequal-types'

/**
 * Turn a lender offer + an allocated principal into a CoverageLine.
 * Reuses the existing amortization engine so monthly-payment math stays
 * consistent with the rest of the financing calculator (DRY).
 */
export function buildCoverageLine(offer: LenderPrequalOffer, amount: number): CoverageLine {
  const rounded = Math.round(amount * 100) / 100
  const schedule = generateAmortizationSchedule(
    rounded,
    offer.apr,
    offer.term_months,
    offer.promo_period_months,
  )
  const monthly = schedule[0]?.payment ?? 0

  return {
    lender_slug: offer.lender_slug,
    lender_name: offer.lender_name,
    amount: rounded,
    apr: offer.apr,
    term_months: offer.term_months,
    promo_period_months: offer.promo_period_months,
    monthly_payment: Math.round(monthly * 100) / 100,
    is_promo: offer.promo_period_months > 0 || offer.apr === 0,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/financing/__tests__/coverage-line.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/financing/coverage-line.ts src/lib/financing/__tests__/coverage-line.test.ts
git commit -m "feat(financing): buildCoverageLine amount->monthly primitive"
```

---

## Task 3: orderOffersForStrategy (learning-mode contribution) + allocateCoverage

**Files:**
- Create: `src/lib/financing/allocate-coverage.ts`
- Test: `src/lib/financing/__tests__/allocate-coverage.test.ts`

> **Learning-mode note:** `orderOffersForStrategy()` is the function that encodes
> the practice's stacking philosophy. A complete, working default is provided
> below (minimize blended APR: 0%-promo and cheapest money first). During
> execution, the user may refine the `minimize_lenders` / `maximize_certainty`
> branches to match how they actually prefer to combine lenders. The tests below
> pin the default `minimize_apr` behavior so refinements stay safe.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { allocateCoverage, orderOffersForStrategy } from '@/lib/financing/allocate-coverage'
import type { LenderPrequalOffer } from '@/lib/financing/prequal-types'

const cherry: LenderPrequalOffer = {
  lender_slug: 'cherry', lender_name: 'Cherry', decision: 'approved',
  approved_amount: 15000, apr: 0, term_months: 12, promo_period_months: 12,
}
const proceed: LenderPrequalOffer = {
  lender_slug: 'proceed', lender_name: 'Proceed Finance', decision: 'approved',
  approved_amount: 20000, apr: 9.9, term_months: 60, promo_period_months: 0,
}
const carecredit: LenderPrequalOffer = {
  lender_slug: 'carecredit', lender_name: 'CareCredit', decision: 'approved',
  approved_amount: 10000, apr: 14.9, term_months: 24, promo_period_months: 0,
}
const declined: LenderPrequalOffer = {
  lender_slug: 'affirm', lender_name: 'Affirm', decision: 'declined',
  approved_amount: 0, apr: 0, term_months: 0, promo_period_months: 0,
}

describe('orderOffersForStrategy (minimize_apr default)', () => {
  it('puts 0% promo first, then ascending APR', () => {
    const ordered = orderOffersForStrategy([carecredit, proceed, cherry], 'minimize_apr')
    expect(ordered.map(o => o.lender_slug)).toEqual(['cherry', 'proceed', 'carecredit'])
  })
})

describe('allocateCoverage', () => {
  it('stacks three lenders to fully cover a $45k treatment with no gap', () => {
    const plan = allocateCoverage(45000, [carecredit, proceed, cherry], 'minimize_apr')
    expect(plan.lines).toHaveLength(3)
    expect(plan.lines[0].lender_slug).toBe('cherry') // cheapest first
    expect(plan.total_loan).toBe(45000)
    expect(plan.gap).toBe(0)
    expect(plan.lines[0].monthly_payment).toBe(1250) // 15000 @ 0% / 12
    expect(plan.total_monthly).toBeCloseTo(
      plan.lines.reduce((s, l) => s + l.monthly_payment, 0), 2,
    )
  })

  it('uses a single lender when one approval covers the whole total', () => {
    const plan = allocateCoverage(12000, [proceed], 'minimize_apr')
    expect(plan.lines).toHaveLength(1)
    expect(plan.lines[0].amount).toBe(12000) // partial draw of the 20000 approval
    expect(plan.gap).toBe(0)
  })

  it('reports the remaining gap when approvals fall short of the total', () => {
    const plan = allocateCoverage(45000, [cherry, carecredit], 'minimize_apr')
    expect(plan.total_loan).toBe(25000) // 15000 + 10000
    expect(plan.gap).toBe(20000)
  })

  it('ignores declined offers', () => {
    const plan = allocateCoverage(10000, [declined, cherry], 'minimize_apr')
    expect(plan.lines).toHaveLength(1)
    expect(plan.lines[0].lender_slug).toBe('cherry')
    expect(plan.lines[0].amount).toBe(10000)
  })

  it('returns an empty plan with a full gap when there are no approved offers', () => {
    const plan = allocateCoverage(30000, [declined], 'minimize_apr')
    expect(plan.lines).toHaveLength(0)
    expect(plan.total_loan).toBe(0)
    expect(plan.total_monthly).toBe(0)
    expect(plan.gap).toBe(30000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/financing/__tests__/allocate-coverage.test.ts`
Expected: FAIL — cannot resolve `@/lib/financing/allocate-coverage`.

- [ ] **Step 3: Write the implementation**

```typescript
import type {
  LenderPrequalOffer, CoveragePlan, CoverageLine, StackingStrategy,
} from './prequal-types'
import { buildCoverageLine } from './coverage-line'

/**
 * Order approved offers by the chosen stacking strategy.
 *
 * LEARNING-MODE CONTRIBUTION: this encodes the practice's philosophy for which
 * lenders to draw from first when combining loans. The default (minimize_apr)
 * fills with 0%-promo and cheapest money first. Refine minimize_lenders /
 * maximize_certainty to taste — the allocateCoverage tests pin minimize_apr.
 */
export function orderOffersForStrategy(
  offers: LenderPrequalOffer[],
  strategy: StackingStrategy,
): LenderPrequalOffer[] {
  const list = [...offers]
  switch (strategy) {
    case 'minimize_lenders':
      // Fewest accounts: largest approvals first.
      return list.sort((a, b) => b.approved_amount - a.approved_amount)
    case 'maximize_certainty':
      // Most-certain funding first: largest approvals, promo as tiebreaker.
      return list.sort((a, b) =>
        b.approved_amount - a.approved_amount ||
        Number(b.promo_period_months > 0) - Number(a.promo_period_months > 0))
    case 'minimize_apr':
    default: {
      // Cheapest money first: 0%/promo, then ascending APR, then larger approval.
      const effectiveApr = (o: LenderPrequalOffer) =>
        o.promo_period_months > 0 ? -1 : o.apr
      return list.sort((a, b) =>
        effectiveApr(a) - effectiveApr(b) ||
        b.approved_amount - a.approved_amount)
    }
  }
}

/**
 * Build a stacked coverage plan: combine approved lender offers, in strategy
 * order, until the treatment total is covered (or offers are exhausted).
 * Pure — no I/O. Any shortfall is reported as `gap`.
 */
export function allocateCoverage(
  treatmentTotal: number,
  offers: LenderPrequalOffer[],
  strategy: StackingStrategy = 'minimize_apr',
): CoveragePlan {
  const approved = offers.filter(o => o.decision === 'approved' && o.approved_amount > 0)
  const ordered = orderOffersForStrategy(approved, strategy)

  const lines: CoverageLine[] = []
  let remaining = treatmentTotal
  for (const offer of ordered) {
    if (remaining <= 0) break
    const amount = Math.min(offer.approved_amount, remaining)
    if (amount <= 0) continue
    lines.push(buildCoverageLine(offer, amount))
    remaining = Math.round((remaining - amount) * 100) / 100
  }

  const total_loan = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100
  const total_monthly = Math.round(lines.reduce((s, l) => s + l.monthly_payment, 0) * 100) / 100

  return {
    lines,
    treatment_total: treatmentTotal,
    total_loan,
    total_monthly,
    gap: Math.round((treatmentTotal - total_loan) * 100) / 100,
    strategy,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/financing/__tests__/allocate-coverage.test.ts`
Expected: PASS (6 passing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/financing/allocate-coverage.ts src/lib/financing/__tests__/allocate-coverage.test.ts
git commit -m "feat(financing): allocateCoverage stacking allocator + strategy ordering"
```

---

## Task 4: computeSelectionTotals (live totals for interactive selection)

**Files:**
- Create: `src/lib/financing/selection-totals.ts`
- Test: `src/lib/financing/__tests__/selection-totals.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { computeSelectionTotals } from '@/lib/financing/selection-totals'
import type { LenderPrequalOffer } from '@/lib/financing/prequal-types'

const cherry: LenderPrequalOffer = {
  lender_slug: 'cherry', lender_name: 'Cherry', decision: 'approved',
  approved_amount: 15000, apr: 0, term_months: 12, promo_period_months: 12,
}
const proceed: LenderPrequalOffer = {
  lender_slug: 'proceed', lender_name: 'Proceed Finance', decision: 'approved',
  approved_amount: 20000, apr: 9.9, term_months: 60, promo_period_months: 0,
}

describe('computeSelectionTotals', () => {
  it('sums selected loan amounts and monthly payments', () => {
    const totals = computeSelectionTotals(
      [{ offer: cherry, amount: 15000 }, { offer: proceed, amount: 20000 }],
      45000,
    )
    expect(totals.selected_count).toBe(2)
    expect(totals.total_loan).toBe(35000)
    expect(totals.covered).toBe(35000)
    expect(totals.gap).toBe(10000)
    expect(totals.total_monthly).toBeCloseTo(
      totals.lines.reduce((s, l) => s + l.monthly_payment, 0), 2,
    )
  })

  it('clamps a requested amount to the lender approved cap', () => {
    const totals = computeSelectionTotals([{ offer: cherry, amount: 99999 }], 45000)
    expect(totals.total_loan).toBe(15000) // clamped to approved 15000
    expect(totals.lines[0].amount).toBe(15000)
  })

  it('never reports negative gap when selection exceeds the treatment total', () => {
    const totals = computeSelectionTotals(
      [{ offer: cherry, amount: 15000 }, { offer: proceed, amount: 20000 }],
      30000,
    )
    expect(totals.total_loan).toBe(35000)
    expect(totals.covered).toBe(30000) // capped at treatment total
    expect(totals.gap).toBe(0)
  })

  it('returns zeros for an empty selection', () => {
    const totals = computeSelectionTotals([], 30000)
    expect(totals.selected_count).toBe(0)
    expect(totals.total_loan).toBe(0)
    expect(totals.total_monthly).toBe(0)
    expect(totals.gap).toBe(30000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/financing/__tests__/selection-totals.test.ts`
Expected: FAIL — cannot resolve `@/lib/financing/selection-totals`.

- [ ] **Step 3: Write the implementation**

```typescript
import type { LenderSelection, SelectionTotals, CoverageLine } from './prequal-types'
import { buildCoverageLine } from './coverage-line'

/**
 * Compute live totals for an arbitrary lender selection (drives the interactive
 * "pick which lenders to proceed with" UI). Each requested amount is clamped to
 * that lender's approved cap. Pure — safe to call on every checkbox/slider change.
 */
export function computeSelectionTotals(
  selections: LenderSelection[],
  treatmentTotal: number,
): SelectionTotals {
  const lines: CoverageLine[] = selections
    .map(({ offer, amount }) => {
      const clamped = Math.max(0, Math.min(amount, offer.approved_amount))
      return clamped > 0 ? buildCoverageLine(offer, clamped) : null
    })
    .filter((l): l is CoverageLine => l !== null)

  const total_loan = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100
  const total_monthly = Math.round(lines.reduce((s, l) => s + l.monthly_payment, 0) * 100) / 100
  const covered = Math.min(total_loan, treatmentTotal)

  return {
    lines,
    total_loan,
    total_monthly,
    covered,
    gap: Math.round(Math.max(0, treatmentTotal - total_loan) * 100) / 100,
    selected_count: lines.length,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/financing/__tests__/selection-totals.test.ts`
Expected: PASS (4 passing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/financing/selection-totals.ts src/lib/financing/__tests__/selection-totals.test.ts
git commit -m "feat(financing): computeSelectionTotals live selection math"
```

---

## Task 5: Full suite + typecheck gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full financing test suite**

Run: `npx vitest run src/lib/financing`
Expected: PASS — all new tests green, no existing financing tests broken.

- [ ] **Step 2: Typecheck (main Vercel build fails on tsc errors — see [[type-errors-block-vercel]])**

Run: `npx tsc --noEmit`
Expected: no new errors in the four new files.

- [ ] **Step 3: Commit any lint/type fixes if needed**

```bash
git add -A
git commit -m "chore(financing): typecheck clean for prequal core"
```

---

## Next plans (not in this document)

- **Plan 2 — Collect-all engine + shared component:** add a collect-all prequal
  mode to the engine that runs `preQualify()` across all active lenders in
  parallel and persists `LenderPrequalOffer[]`; build the interactive
  `PrequalResults` React component (consumes `allocateCoverage` +
  `computeSelectionTotals`); wire it into staff lead-detail.
- **Plan 3 — Patient surface + checkout/resume + aggregator:** replace the
  single-result `ResultScreen` on `/finance/[shareToken]`; add the Checkout
  Session model, reusable resume token, Checkout Status page, staff one-tap /
  patient self-report reconciliation; add the aggregator adapter (per the
  decided aggregator-first hybrid strategy).

## Self-review (done)

- **Spec coverage:** this plan implements the spec's "Stacking allocator (§2)"
  and "Interactive selection + live totals (§4, pure part)". Collect-all engine,
  component, checkout, roster are explicitly deferred to Plans 2–3.
- **Placeholder scan:** none — every step has real code and exact commands.
- **Type consistency:** `LenderPrequalOffer`, `CoverageLine`, `CoveragePlan`,
  `LenderSelection`, `SelectionTotals` defined in Task 1 and used unchanged in
  Tasks 2–4; `buildCoverageLine(offer, amount)` signature identical across the
  allocator and selection-totals; reuses the real `generateAmortizationSchedule`
  export from `calculator.ts`.
