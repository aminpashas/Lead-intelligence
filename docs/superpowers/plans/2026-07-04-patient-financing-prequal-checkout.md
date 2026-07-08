# Patient Financing Prequal — Patient Surface + Checkout/Resume (Plan 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Checkbox (`- [ ]`) steps.

**Goal:** Let the patient see their stacked prequal results on the public page, "check out" a selected plan, and — since lenders send their own links and completion is off-site over days — pick the process back up on a durable resume page reconciled by staff one-tap + patient self-report.

**Architecture:** A pure checkout state machine (sub-application status + funded coverage) is the "pick back up" brain — fully unit-tested. A gated migration adds `financing_checkout_sessions` + `financing_checkout_subapps`. The public `/finance/[shareToken]` page reuses the Plan-2 `PrequalResults` component. A durable resume page + reconciliation endpoints (staff confirm / patient self-report) advance sub-application state. The aggregator adapter is scaffolded to the existing `LenderAdapter` interface (real API wiring pending a partner contract).

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase RLS, Vitest, React.

**Depends on:** Plan 1 + Plan 2 (both committed). Reuses `PrequalResults`, `LenderPrequalOffer`, `LenderTermOption`.

**Spec:** `docs/superpowers/specs/2026-07-04-patient-financing-prequal-design.md` §5.

> **⚠️ Gates:** (1) Migrations (Task 2) are file-only — a human applies to prod.
> (2) Real lender **link dispatch** and the **aggregator API** need partner
> credentials/contracts; those tasks scaffold the seam and use the existing
> adapter methods, not live partner calls. Reconciliation is staff/patient-driven
> per the practice's actual workflow (dashboard + email + patient tells us).

---

## File structure

- Create `src/lib/financing/checkout-session.ts` — pure state machine (`applyReconciliation`, `computeCheckoutProgress`) + types.
- Create `src/lib/financing/__tests__/checkout-session.test.ts`.
- Create `supabase/migrations/20260704190000_financing_checkout.sql` — sessions + sub-apps + RLS. **(gated)**
- Create `src/app/api/financing/checkout/route.ts` — `POST` create session from a selection (staff or public).
- Create `src/app/api/financing/checkout/[token]/route.ts` — `GET` session (public, by resume token) + `PATCH` reconcile one sub-app (auth staff OR patient self-report, gated by token).
- Create `src/app/finance/[shareToken]/checkout/page.tsx` — public **resume/status page** reusing progress.
- Modify `src/components/forms/financing-application-form.tsx` — after submit, render `PrequalResults` (Plan 2) instead of the single-result `ResultScreen`.
- Create `src/lib/financing/adapters/aggregator.ts` — scaffolded aggregator adapter (`LenderAdapter`), config-driven, link-based by default.

---

## Task 1 (TDD): Checkout state machine — the "pick back up" brain

**Files:** Create `src/lib/financing/checkout-session.ts`, `src/lib/financing/__tests__/checkout-session.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import {
  applyReconciliation, computeCheckoutProgress,
  type CheckoutSession,
} from '@/lib/financing/checkout-session'

const term = { apr: 9.9, term_months: 60, promo_period_months: 0 }
const session = (): CheckoutSession => ({
  treatment_total: 45000,
  sub_apps: [
    { lender_slug: 'proceed', lender_name: 'Proceed Finance', requested_amount: 20000, term, status: 'link_sent', funded_amount: 0, confirmed_by: null },
    { lender_slug: 'cherry', lender_name: 'Cherry', requested_amount: 15000, term, status: 'link_sent', funded_amount: 0, confirmed_by: null },
    { lender_slug: 'carecredit', lender_name: 'CareCredit', requested_amount: 10000, term, status: 'selected', funded_amount: 0, confirmed_by: null },
  ],
})

describe('computeCheckoutProgress', () => {
  it('reports nothing funded and all lenders outstanding at the start', () => {
    const p = computeCheckoutProgress(session())
    expect(p.funded_total).toBe(0)
    expect(p.outstanding_lenders).toHaveLength(3)
    expect(p.is_complete).toBe(false)
    expect(p.status).toBe('in_progress')
  })

  it('sums funded amounts and completes when the total is covered', () => {
    let s = session()
    s = applyReconciliation(s, { lender_slug: 'proceed', status: 'funded', funded_amount: 20000, confirmed_by: 'staff' })
    s = applyReconciliation(s, { lender_slug: 'cherry', status: 'funded', funded_amount: 15000, confirmed_by: 'patient' })
    s = applyReconciliation(s, { lender_slug: 'carecredit', status: 'funded', funded_amount: 10000, confirmed_by: 'staff' })
    const p = computeCheckoutProgress(s)
    expect(p.funded_total).toBe(45000)
    expect(p.covered).toBe(45000)
    expect(p.outstanding_total).toBe(0)
    expect(p.outstanding_lenders).toHaveLength(0)
    expect(p.is_complete).toBe(true)
    expect(p.status).toBe('complete')
  })

  it('keeps the shortfall outstanding when a lender is declined', () => {
    let s = session()
    s = applyReconciliation(s, { lender_slug: 'proceed', status: 'funded', funded_amount: 20000, confirmed_by: 'staff' })
    s = applyReconciliation(s, { lender_slug: 'cherry', status: 'declined', confirmed_by: 'staff' })
    const p = computeCheckoutProgress(s)
    expect(p.funded_total).toBe(20000)
    expect(p.outstanding_total).toBe(25000)
    // carecredit still open; cherry declined is NOT outstanding (terminal)
    expect(p.outstanding_lenders.map(l => l.lender_slug)).toEqual(['carecredit'])
    expect(p.is_complete).toBe(false)
  })

  it('is immutable — applyReconciliation returns a new session', () => {
    const s0 = session()
    const s1 = applyReconciliation(s0, { lender_slug: 'proceed', status: 'started', confirmed_by: 'patient' })
    expect(s0.sub_apps[0].status).toBe('link_sent')
    expect(s1.sub_apps[0].status).toBe('started')
  })
})
```

- [ ] **Step 2: Run to verify fail** — `npx vitest run src/lib/financing/__tests__/checkout-session.test.ts` → module not found.

- [ ] **Step 3: Implement `src/lib/financing/checkout-session.ts`**

```typescript
import type { LenderSlug } from './types'
import type { LenderTermOption } from './prequal-types'

export type SubAppStatus =
  | 'selected' | 'link_sent' | 'started' | 'approved' | 'funded' | 'declined' | 'expired'

const TERMINAL: SubAppStatus[] = ['funded', 'declined', 'expired']

export type CheckoutSubApp = {
  lender_slug: LenderSlug
  lender_name: string
  requested_amount: number
  term: LenderTermOption
  status: SubAppStatus
  funded_amount: number
  confirmed_by?: 'staff' | 'patient' | 'webhook' | null
}

export type CheckoutSession = {
  treatment_total: number
  sub_apps: CheckoutSubApp[]
}

export type ReconcileEvent = {
  lender_slug: LenderSlug
  status: SubAppStatus
  funded_amount?: number
  confirmed_by?: 'staff' | 'patient' | 'webhook'
}

export type CheckoutProgress = {
  funded_total: number
  covered: number
  outstanding_total: number
  outstanding_lenders: CheckoutSubApp[]
  is_complete: boolean
  status: 'not_started' | 'in_progress' | 'complete'
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Apply one reconciliation event (staff confirm, patient self-report, or webhook)
 * to the matching sub-application. Pure — returns a new session, never mutates.
 * A 'funded' event sets funded_amount (falling back to requested_amount).
 */
export function applyReconciliation(session: CheckoutSession, event: ReconcileEvent): CheckoutSession {
  return {
    ...session,
    sub_apps: session.sub_apps.map(sa => {
      if (sa.lender_slug !== event.lender_slug) return sa
      const funded_amount = event.status === 'funded'
        ? (event.funded_amount ?? sa.requested_amount)
        : sa.funded_amount
      return { ...sa, status: event.status, funded_amount, confirmed_by: event.confirmed_by ?? sa.confirmed_by ?? null }
    }),
  }
}

/**
 * Derive live progress: funded total, coverage vs. treatment total, which
 * lenders are still outstanding (non-terminal), and whether the plan is complete.
 */
export function computeCheckoutProgress(session: CheckoutSession): CheckoutProgress {
  const funded_total = round2(session.sub_apps
    .filter(sa => sa.status === 'funded')
    .reduce((s, sa) => s + sa.funded_amount, 0))
  const outstanding_lenders = session.sub_apps.filter(sa => !TERMINAL.includes(sa.status))
  const is_complete = funded_total >= session.treatment_total
  const anyActivity = session.sub_apps.some(sa => sa.status !== 'selected')
  return {
    funded_total,
    covered: Math.min(funded_total, session.treatment_total),
    outstanding_total: round2(Math.max(0, session.treatment_total - funded_total)),
    outstanding_lenders,
    is_complete,
    status: is_complete ? 'complete' : anyActivity ? 'in_progress' : 'not_started',
  }
}
```

- [ ] **Step 4: Run to verify pass** — all pass. Also `npx vitest run src/lib/financing` (nothing broken) and `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/financing/checkout-session.ts src/lib/financing/__tests__/checkout-session.test.ts
git commit -m "feat(financing): checkout state machine (pick-back-up progress)"
```

---

## Task 2: Checkout migration (GATED — file only)

**Files:** Create `supabase/migrations/20260704190000_financing_checkout.sql`

- [ ] **Step 1: Write the migration** — two org-scoped RLS tables:
  - `financing_checkout_sessions` (id, organization_id, lead_id, treatment_total numeric, resume_token text unique, status text, created_at, updated_at). resume_token is durable/reusable (unlike the 24h prequal link).
  - `financing_checkout_subapps` (id, organization_id, session_id fk, lender_slug, lender_name, requested_amount numeric, term jsonb, status text check in the 7 states, funded_amount numeric default 0, confirmed_by text null, application_url text null, created_at, updated_at).
  - Enable RLS + `org_isolation` policies using `public.get_user_org_id()` (mirror `20260704180000_financing_prequal_offers.sql`). Index subapps by session_id; sessions by resume_token and lead_id.
- [ ] **Step 2:** Do NOT apply to prod. Eyeball against the prequal-offers migration.
- [ ] **Step 3: Commit** `feat(financing): migration for checkout sessions + subapps (gated)`

---

## Task 3: Checkout endpoints

**Files:** Create `src/app/api/financing/checkout/route.ts` (POST create), `src/app/api/financing/checkout/[token]/route.ts` (GET + PATCH)

- [ ] **POST /api/financing/checkout** (auth staff): body `{ lead_id, treatment_total, selections: [{lender_slug, lender_name, requested_amount, term, application_url?}] }`. Generate `resume_token = crypto.randomUUID()`. Insert one session + N subapps (status 'selected'; if a lender is link-based and an application_url is provided, set status 'link_sent' + store url). Return `{ resume_token, session }`.
- [ ] **GET /api/financing/checkout/[token]** (PUBLIC by token): load session + subapps by resume_token, build `CheckoutSession`, return it plus `computeCheckoutProgress(session)`. No auth (token is the capability) — but never expose PII beyond lender/amount/status.
- [ ] **PATCH /api/financing/checkout/[token]** reconcile one sub-app: body `{ lender_slug, status, funded_amount?, confirmed_by }`. Staff (authenticated, org matches) may set any status incl. 'funded'. Patient self-report (token-only, unauthenticated) may set only 'started' or a *pending* 'funded' that staff must confirm — enforce: unauthenticated `confirmed_by` is forced to `'patient'` and a `funded` self-report is stored as `approved` (not `funded`) until staff confirms. Persist via `applyReconciliation` semantics, recompute progress, return it.
- [ ] Typecheck + commit.

---

## Task 4: Patient results surface — reuse `PrequalResults`

**Files:** Modify `src/components/forms/financing-application-form.tsx`

- [ ] After a successful submit, instead of the single-result `ResultScreen`, call `/api/financing/prequal` (or accept offers from the submit response) and render `<PrequalResults treatmentTotal={requestedAmount} offers={offers} />`, followed by a "Proceed with selected plan" button that POSTs to `/api/financing/checkout` and routes the patient to `/finance/[shareToken]/checkout`. Keep the existing soft-pull consent checkbox + "won't affect your credit score" copy. Preserve the public/share-token flow (no auth).
- [ ] Verify in browser (public page renders results; this is browser-observable).
- [ ] Commit.

---

## Task 5: Resume / checkout-status page

**Files:** Create `src/app/finance/[shareToken]/checkout/page.tsx`

- [ ] Public page: fetch `GET /api/financing/checkout/[token]`, render per-lender progress (✓ funded / ⏳ link sent — finish it / ◻ not started / ✗ declined) using the `CheckoutProgress` shape, show funded vs. treatment total and what's outstanding. Patient actions: open each lender's `application_url`; "I finished this one" → PATCH self-report. This is the durable "pick back up" surface.
- [ ] Add the same progress panel to the **staff** lead-detail (in `lead-financing-card.tsx`) with one-tap "Mark funded" per sub-app → PATCH (authenticated). 
- [ ] Verify in browser. Commit.

---

## Task 6: Aggregator adapter scaffold

**Files:** Create `src/lib/financing/adapters/aggregator.ts`; register in `src/lib/financing/adapters/index.ts`

- [ ] Implement a `LenderAdapter` (integrationType 'link') for the chosen aggregator (Versatile / ChargeAfter / FinMkt) that: `generateApplicationUrl(leadData, config)` returns the aggregator's hosted waterfall URL from `config`; `getPaymentEstimate` optionally returns configured indicative terms; leaves `preQualify`/`submitApplication` unimplemented until a partner API contract exists (documented TODO). Add its slug to `LenderSlug` and the config UI enum. **No live partner calls** — the seam only.
- [ ] Typecheck + commit.

---

## Self-review (done)

- **Spec coverage:** checkout session + sub-app state machine (§5), reusable resume token, resume page, staff one-tap + patient self-report reconciliation, patient surface reusing `PrequalResults`, aggregator scaffold (roster/integration strategy). 
- **Placeholders:** Task 1 is complete code; Tasks 3–6 specify endpoints/pages/adapters at buildable detail (routes + component tasks). Real partner API + link dispatch are explicitly gated on contracts.
- **Type consistency:** `CheckoutSession`/`CheckoutSubApp`/`ReconcileEvent`/`CheckoutProgress` defined in Task 1, consumed by Tasks 3 & 5; reuses `LenderTermOption`, `LenderSlug`.
