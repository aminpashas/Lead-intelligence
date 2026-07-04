# Patient Financing Prequal — Collect-All Engine + Staff UI (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Run a soft-pull prequalification across all active lenders in parallel, persist every result, and render the interactive stacked-coverage results (with the acceleration panel) inside the staff lead-detail view.

**Architecture:** A pure mapping layer turns each lender adapter's response into a `LenderPrequalOffer` (Plan 1 type). An orchestration function fans out across active lenders (dependency-injected, so it's unit-testable with fake adapters). A thin authenticated API route persists offers and returns the `CoveragePlan`. A React `PrequalResults` component consumes the Plan-1 pure functions + the existing `calculator.ts` acceleration math.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (RLS via `organization_id`), Vitest, React. Path alias `@/`.

**Depends on:** Plan 1 (`prequal-types`, `allocate-coverage`, `coverage-line`, `selection-totals` — all committed).

**Spec:** `docs/superpowers/specs/2026-07-04-patient-financing-prequal-design.md`

**Scope note:** Plan 2 covers API-`preQualify` lenders (instant soft-pull decision) AND records link/estimate-only lenders as indicative `estimate` offers (shown, not auto-stacked). The checkout/link dispatch, resume page, and patient surface are Plan 3.

> **⚠️ Production gate:** Task 2's migration must NOT be applied to prod by an
> agent. Create the file; a human applies it via the project's migration process
> (`supabase db query --linked -f <file>`). See [[supabase-ai-migration-mechanism]].

---

## Lender adapter facts (ground truth)

- `LenderAdapter.preQualify?(request: Partial<LenderApplicationRequest>, credentials)` → `LenderApplicationResponse { status: 'approved'|'denied'|'pending'|'error', external_id, approved_amount?, terms?: ApprovedTerms }`. **Optional** — link-only lenders (e.g. Cherry) don't implement it.
- `LenderAdapter.getPaymentEstimate?(amount, config, credentials?)` → `PaymentEstimate[]` — the **term menu** (each has `apr`, `term_months`, `promo_period_months?`, `monthly_payment`).
- Active lenders come from `financing_lender_configs` (org-scoped: `lender_slug`, `credentials_encrypted`, `config`, `is_active`, `priority_order`) — same load as `src/app/api/financing/estimate/route.ts`.
- `ApprovedTerms = { apr, term_months, monthly_payment, promo_period_months? }`.

---

## File structure

- Modify `src/lib/financing/prequal-types.ts` — add `'estimate'` to `LenderPrequalOffer.decision`.
- Create `supabase/migrations/20260704180000_financing_prequal_offers.sql` — offers table + RLS. **(gated: do not apply to prod)**
- Create `src/lib/financing/collect-all.ts` — `mapToPrequalOffer()` (pure) + `runCollectAllPrequal()` (DI orchestration).
- Create `src/lib/financing/__tests__/collect-all.test.ts`.
- Create `src/app/api/financing/prequal/route.ts` — `POST` authenticated endpoint.
- Modify `src/lib/validators/financing.ts` — add `prequalRequestSchema`.
- Create `src/components/crm/prequal-results.tsx` — the interactive results component.
- Modify `src/components/crm/lead-financing-card.tsx` — mount `PrequalResults` + a "Run prequalification" action.

---

## Task 1: Extend the offer decision with an `estimate` state

**Files:** Modify `src/lib/financing/prequal-types.ts`

- [ ] **Step 1: Change the `decision` union**

In `LenderPrequalOffer`, change:
```typescript
  decision: 'approved' | 'declined'
```
to:
```typescript
  decision: 'approved' | 'declined' | 'estimate'  // 'estimate' = link-only lender, indicative terms, no instant decision
```

- [ ] **Step 2: Verify allocator still excludes non-approved**

`allocateCoverage` already filters `decision === 'approved'`, so `estimate`/`declined` offers are naturally never auto-stacked. Run: `npx vitest run src/lib/financing` — expected: still 16 passing.

- [ ] **Step 3: Commit**

```bash
git add src/lib/financing/prequal-types.ts
git commit -m "feat(financing): add 'estimate' offer state for link-only lenders"
```

---

## Task 2: `financing_prequal_offers` migration (GATED — file only)

**Files:** Create `supabase/migrations/20260704180000_financing_prequal_offers.sql`

- [ ] **Step 1: Write the migration** (follow the existing org-scoped RLS pattern)

```sql
-- ═══════════════════════════════════════════════════════════════
-- Patient financing prequalification — per-lender soft-pull offers
-- ═══════════════════════════════════════════════════════════════
-- One row per (prequal run, lender). Records the collect-all result so the
-- coverage plan is reproducible and the staff/patient can revisit it.
create table if not exists public.financing_prequal_offers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  run_id uuid not null,                          -- groups a single collect-all run
  requested_amount numeric not null,
  lender_slug text not null,
  lender_name text not null,
  decision text not null check (decision in ('approved','declined','estimate')),
  approved_amount numeric not null default 0,
  terms jsonb not null default '[]'::jsonb,      -- LenderTermOption[]
  created_at timestamptz not null default now()
);

create index if not exists idx_prequal_offers_lead on public.financing_prequal_offers (lead_id, run_id);
create index if not exists idx_prequal_offers_org on public.financing_prequal_offers (organization_id);

alter table public.financing_prequal_offers enable row level security;

drop policy if exists prequal_offers_org_isolation on public.financing_prequal_offers;
create policy prequal_offers_org_isolation on public.financing_prequal_offers
  for all
  using (organization_id = public.get_user_org_id())
  with check (organization_id = public.get_user_org_id());

comment on table public.financing_prequal_offers is 'Per-lender soft-pull prequalification results for a collect-all run. Not a credit grade; decision=estimate means link-only lender (indicative terms).';
```

- [ ] **Step 2: Verify SQL parses locally (no prod apply)**

Do NOT run against prod. If a local Supabase is available: `supabase db lint` or a dry parse. Otherwise eyeball against the pattern in `supabase/migrations/20260617_financial_qualification_status.sql`. Confirm `get_user_org_id()` and `organizations`/`leads` exist (they're used by existing policies).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260704180000_financing_prequal_offers.sql
git commit -m "feat(financing): migration for financing_prequal_offers (gated, not applied)"
```

---

## Task 3 (TDD): Collect-all engine — mapping + orchestration

**Files:** Create `src/lib/financing/collect-all.ts`, `src/lib/financing/__tests__/collect-all.test.ts`

The engine is dependency-injected (adapters + a persist callback passed in) so it's unit-testable with fakes and no network/Supabase.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { mapToPrequalOffer, runCollectAllPrequal } from '@/lib/financing/collect-all'
import type { PaymentEstimate, LenderApplicationResponse } from '@/lib/financing/types'

const estimates = (slug: any): PaymentEstimate[] => ([
  { lender_slug: slug, lender_name: 'X', monthly_payment: 700, financed_amount: 15000, down_payment: 0, apr: 9.99, term_months: 24, promo_period_months: 0 },
  { lender_slug: slug, lender_name: 'X', monthly_payment: 1250, financed_amount: 15000, down_payment: 0, apr: 0, term_months: 12, promo_period_months: 12 },
])

describe('mapToPrequalOffer', () => {
  it('maps an approved soft-pull + estimate menu into an approved offer with terms[]', () => {
    const resp: LenderApplicationResponse = { status: 'approved', external_id: 'x', approved_amount: 15000 }
    const offer = mapToPrequalOffer('cherry', 'Cherry', resp, estimates('cherry'))
    expect(offer.decision).toBe('approved')
    expect(offer.approved_amount).toBe(15000)
    expect(offer.terms).toHaveLength(2)
    expect(offer.terms.map(t => t.term_months).sort()).toEqual([12, 24])
  })

  it('maps a denial to a declined offer with no terms', () => {
    const offer = mapToPrequalOffer('affirm', 'Affirm', { status: 'denied', external_id: null }, [])
    expect(offer.decision).toBe('declined')
    expect(offer.approved_amount).toBe(0)
    expect(offer.terms).toHaveLength(0)
  })

  it('maps a link-only lender (no prequal response) to an estimate offer', () => {
    const offer = mapToPrequalOffer('proceed', 'Proceed Finance', null, estimates('proceed'))
    expect(offer.decision).toBe('estimate')
    expect(offer.approved_amount).toBe(0)
    expect(offer.terms).toHaveLength(2)
  })
})

describe('runCollectAllPrequal', () => {
  it('fans out across active lenders, isolates a failing lender, and persists offers', async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const lenders = [
      { slug: 'cherry', name: 'Cherry',
        preQualify: async () => ({ status: 'approved', external_id: 'a', approved_amount: 15000 } as LenderApplicationResponse),
        getPaymentEstimate: async () => estimates('cherry') },
      { slug: 'proceed', name: 'Proceed Finance',
        preQualify: undefined,
        getPaymentEstimate: async () => estimates('proceed') },
      { slug: 'affirm', name: 'Affirm',
        preQualify: async () => { throw new Error('boom') },
        getPaymentEstimate: async () => estimates('affirm') },
    ]
    const result = await runCollectAllPrequal({
      leadId: 'lead-1', organizationId: 'org-1', requestedAmount: 45000,
      lenders, persist,
    })
    // cherry approved, proceed estimate, affirm falls back to estimate (prequal threw)
    expect(result.offers).toHaveLength(3)
    expect(result.offers.find(o => o.lender_slug === 'cherry')!.decision).toBe('approved')
    expect(result.offers.find(o => o.lender_slug === 'proceed')!.decision).toBe('estimate')
    expect(result.offers.find(o => o.lender_slug === 'affirm')!.decision).toBe('estimate')
    expect(persist).toHaveBeenCalledOnce()
    expect(result.plan.total_loan).toBeGreaterThan(0) // cherry's 15000 stacked
    expect(result.run_id).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/lib/financing/__tests__/collect-all.test.ts` → module not found.

- [ ] **Step 3: Implement**

```typescript
import type { PaymentEstimate, LenderApplicationResponse } from './types'
import type { LenderPrequalOffer, LenderTermOption, CoveragePlan } from './prequal-types'
import { allocateCoverage } from './allocate-coverage'

function estimatesToTerms(estimates: PaymentEstimate[]): LenderTermOption[] {
  const seen = new Set<string>()
  const terms: LenderTermOption[] = []
  for (const e of estimates) {
    const t = { apr: e.apr, term_months: e.term_months, promo_period_months: e.promo_period_months ?? 0 }
    const key = `${t.apr}:${t.term_months}:${t.promo_period_months}`
    if (!seen.has(key)) { seen.add(key); terms.push(t) }
  }
  return terms
}

/**
 * Map one lender's soft-pull response (may be null for link-only lenders) plus
 * its estimate menu into a LenderPrequalOffer.
 *  - approved soft-pull  -> 'approved' with approved_amount + terms
 *  - denied soft-pull    -> 'declined'
 *  - no/ pending / error soft-pull, but estimates exist -> 'estimate' (indicative)
 */
export function mapToPrequalOffer(
  slug: LenderPrequalOffer['lender_slug'],
  name: string,
  prequal: LenderApplicationResponse | null,
  estimates: PaymentEstimate[],
): LenderPrequalOffer {
  const terms = estimatesToTerms(estimates)
  if (prequal && prequal.status === 'approved') {
    const approvedTerms = terms.length > 0
      ? terms
      : prequal.terms
        ? [{ apr: prequal.terms.apr, term_months: prequal.terms.term_months, promo_period_months: prequal.terms.promo_period_months ?? 0 }]
        : []
    return { lender_slug: slug, lender_name: name, decision: 'approved', approved_amount: prequal.approved_amount ?? 0, terms: approvedTerms }
  }
  if (prequal && prequal.status === 'denied') {
    return { lender_slug: slug, lender_name: name, decision: 'declined', approved_amount: 0, terms: [] }
  }
  return { lender_slug: slug, lender_name: name, decision: 'estimate', approved_amount: 0, terms }
}

export type CollectAllLender = {
  slug: LenderPrequalOffer['lender_slug']
  name: string
  preQualify?: (() => Promise<LenderApplicationResponse>) | undefined
  getPaymentEstimate?: (() => Promise<PaymentEstimate[]>) | undefined
}

export type CollectAllArgs = {
  leadId: string
  organizationId: string
  requestedAmount: number
  runId?: string
  lenders: CollectAllLender[]
  persist: (rows: { offer: LenderPrequalOffer; runId: string }[]) => Promise<void>
}

export type CollectAllResult = {
  run_id: string
  offers: LenderPrequalOffer[]
  plan: CoveragePlan
}

/**
 * Fan out across active lenders in parallel: soft-pull where supported, pull the
 * estimate menu, map to offers, persist, and build the recommended coverage plan.
 * A single lender failing (bad creds, timeout) must not sink the batch — it
 * degrades to an 'estimate' offer or is dropped, never silently hidden.
 */
export async function runCollectAllPrequal(args: CollectAllArgs): Promise<CollectAllResult> {
  const runId = args.runId ?? cryptoRandomId()
  const offers = await Promise.all(args.lenders.map(async (l) => {
    let prequal: LenderApplicationResponse | null = null
    let estimates: PaymentEstimate[] = []
    if (l.preQualify) {
      try { prequal = await l.preQualify() } catch (err) {
        console.error(`[collect-all] ${l.slug} preQualify failed:`, err instanceof Error ? err.message : err)
        prequal = null
      }
    }
    if (l.getPaymentEstimate) {
      try { estimates = await l.getPaymentEstimate() } catch (err) {
        console.error(`[collect-all] ${l.slug} getPaymentEstimate failed:`, err instanceof Error ? err.message : err)
        estimates = []
      }
    }
    return mapToPrequalOffer(l.slug, l.name, prequal, estimates)
  }))

  await args.persist(offers.map(offer => ({ offer, runId })))
  const plan = allocateCoverage(args.requestedAmount, offers)
  return { run_id: runId, offers, plan }
}

// Non-crypto random id is fine here (grouping key, not a security token). Avoids
// importing node:crypto in a module that also runs under Vitest.
function cryptoRandomId(): string {
  return 'run_' + Math.abs(hashNow()).toString(36) + Math.floor(performanceNow()).toString(36)
}
function hashNow(): number { return (globalThis.crypto?.getRandomValues?.(new Uint32Array(1))?.[0]) ?? 0 }
function performanceNow(): number { return (globalThis.performance?.now?.() ?? 0) }
```

> Note for implementer: if `globalThis.crypto.randomUUID` is available in this
> runtime (Node 24 — it is), simplify `cryptoRandomId()` to
> `return globalThis.crypto.randomUUID()`. Keep the run_id opaque.

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/financing/__tests__/collect-all.test.ts` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/financing/collect-all.ts src/lib/financing/__tests__/collect-all.test.ts
git commit -m "feat(financing): collect-all prequal engine (mapping + DI orchestration)"
```

---

## Task 4: Authenticated `POST /api/financing/prequal` endpoint

**Files:** Create `src/app/api/financing/prequal/route.ts`; modify `src/lib/validators/financing.ts`

- [ ] **Step 1: Add the request schema** to `src/lib/validators/financing.ts`

```typescript
export const prequalRequestSchema = z.object({
  lead_id: z.string().uuid(),
  amount: z.number().positive().max(250_000),
})
export type PrequalRequestInput = z.infer<typeof prequalRequestSchema>
```

- [ ] **Step 2: Implement the route** — mirror the auth + lender-load pattern in `src/app/api/financing/estimate/route.ts`, then call the engine.

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { prequalRequestSchema } from '@/lib/validators/financing'
import { getLenderAdapter } from '@/lib/financing/adapters'
import { decryptCredentials } from '@/lib/financing/encryption-helpers'
import { runCollectAllPrequal, type CollectAllLender } from '@/lib/financing/collect-all'
import type { LenderSlug } from '@/lib/financing/types'

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { orgId } = await resolveActiveOrg(supabase)
    if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json()
    const parsed = prequalRequestSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors }, { status: 400 })
    }
    const { lead_id, amount } = parsed.data

    const { data: lenderConfigs } = await supabase
      .from('financing_lender_configs')
      .select('lender_slug, credentials_encrypted, config, is_active')
      .eq('organization_id', orgId)
      .eq('is_active', true)
      .order('priority_order', { ascending: true })

    if (!lenderConfigs || lenderConfigs.length === 0) {
      return NextResponse.json({ offers: [], plan: null, message: 'No active lenders configured' })
    }

    const lenders: CollectAllLender[] = lenderConfigs.map((lc) => {
      const adapter = getLenderAdapter(lc.lender_slug as LenderSlug)
      const credentials = lc.credentials_encrypted ? decryptCredentials(lc.credentials_encrypted) : undefined
      return {
        slug: lc.lender_slug as LenderSlug,
        name: adapter.displayName,
        preQualify: adapter.preQualify && credentials
          ? () => adapter.preQualify!({ requested_amount: amount }, credentials)
          : undefined,
        getPaymentEstimate: adapter.getPaymentEstimate
          ? () => adapter.getPaymentEstimate!(amount, lc.config || {}, credentials)
          : undefined,
      }
    })

    const result = await runCollectAllPrequal({
      leadId: lead_id, organizationId: orgId, requestedAmount: amount, lenders,
      persist: async (rows) => {
        if (rows.length === 0) return
        await supabase.from('financing_prequal_offers').insert(rows.map(({ offer, runId }) => ({
          organization_id: orgId, lead_id, run_id: runId, requested_amount: amount,
          lender_slug: offer.lender_slug, lender_name: offer.lender_name,
          decision: offer.decision, approved_amount: offer.approved_amount, terms: offer.terms,
        })))
      },
    })

    return NextResponse.json(result)
  } catch (error) {
    console.error('[financing/prequal] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
```

- [ ] **Step 3: Typecheck** — `npx tsc --noEmit` → 0 errors. (Confirm `resolveActiveOrg`, `decryptCredentials`, `getLenderAdapter` import paths match the estimate route.)

- [ ] **Step 4: Commit**

```bash
git add src/app/api/financing/prequal/route.ts src/lib/validators/financing.ts
git commit -m "feat(financing): POST /api/financing/prequal collect-all endpoint"
```

---

## Task 5: `PrequalResults` component + wire into staff lead-detail

**Files:** Create `src/components/crm/prequal-results.tsx`; modify `src/components/crm/lead-financing-card.tsx`

This renders the approved mockup: coverage bar → recommended stacked plan (from `allocateCoverage`) → interactive selection (checkbox + amount + term per lender, live totals via `computeSelectionTotals`) → "other offers / apply" list (estimate + declined) → payoff-acceleration panel (reuse `calculator.ts`).

- [ ] **Step 1: Build the component** with these responsibilities (props + core logic; match the Aurea styling already used in `financing-waterfall-tracker.tsx`):

```typescript
'use client'
import { useMemo, useState } from 'react'
import type { LenderPrequalOffer, LenderSelection, LenderTermOption } from '@/lib/financing/prequal-types'
import { allocateCoverage } from '@/lib/financing/allocate-coverage'
import { computeSelectionTotals } from '@/lib/financing/selection-totals'
import { pickAffordableTerm } from '@/lib/financing/coverage-line'
import { generateAmortizationSchedule } from '@/lib/financing/calculator'

type Props = { treatmentTotal: number; offers: LenderPrequalOffer[] }

export function PrequalResults({ treatmentTotal, offers }: Props) {
  const approved = offers.filter(o => o.decision === 'approved')
  const others = offers.filter(o => o.decision !== 'approved')

  // Default selection = the recommended stacked plan (amount-first, longest term).
  const recommended = useMemo(() => allocateCoverage(treatmentTotal, approved), [treatmentTotal, offers])
  const [selections, setSelections] = useState<LenderSelection[]>(() =>
    recommended.lines.map(line => {
      const offer = approved.find(o => o.lender_slug === line.lender_slug)!
      return { offer, amount: line.amount, term: pickAffordableTerm(offer, line.amount) }
    }))

  const totals = useMemo(() => computeSelectionTotals(selections, treatmentTotal), [selections, treatmentTotal])

  // toggleLender(offer), setAmount(slug, n), setTerm(slug, term) update `selections`.
  // Render: coverage bar (totals.covered / treatmentTotal), per-lender rows with
  // checkbox + amount input (max offer.approved_amount) + term <select> over
  // offer.terms, live totals.total_loan / totals.total_monthly / totals.gap,
  // an "other offers you qualify for" list (others), and the acceleration panel
  // below (Step 2). No new money math — only the Plan-1 pure fns + calculator.ts.

  return null // replace with the JSX described above
}
```

- [ ] **Step 2: Acceleration panel** — for the selected plan's blended figures, reuse `generateAmortizationSchedule` to show "pay biweekly + $100/mo extra → save $X, finish Y months early." Compute from the longest-term line(s); label it "No prepayment penalty — pay it off faster." (The existing `calculateBiweeklyDetails` / `calculateExtraPaymentSavings` in `calculator.ts` are per-scenario helpers you may call, or compute directly from the schedule.)

- [ ] **Step 3: Wire into `LeadFinancingCard`** — add a "Run prequalification" button that `POST`s `/api/financing/prequal` with `{ lead_id: lead.id, amount: Number(estimateAmount) }`, stores `offers` in state, and renders `<PrequalResults treatmentTotal={amount} offers={offers} />` below the existing estimates block.

- [ ] **Step 4: Verify in the browser** (this IS browser-observable — follow the preview verification workflow): start the dev server, open a lead, run prequal, confirm the recommended plan renders, toggling a lender updates the totals, and the acceleration panel shows savings. Screenshot for the user.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/components/crm/prequal-results.tsx src/components/crm/lead-financing-card.tsx
git commit -m "feat(financing): interactive PrequalResults in staff lead-detail"
```

---

## Self-review (done)

- **Spec coverage:** collect-all engine (§1), offers persistence (Data model), `PrequalResults` (§3), interactive selection + live totals (§4), acceleration panel (§6). Checkout/resume + patient surface + aggregator = Plan 3.
- **Placeholders:** Task 5's component gives structure + props + core logic rather than full JSX (a component task); every backend task is complete code.
- **Type consistency:** uses Plan-1 exports unchanged; `CollectAllLender`/`CollectAllArgs`/`CollectAllResult` defined in Task 3 and consumed in Task 4; `mapToPrequalOffer` signature identical across test and impl.
- **Gate:** migration is file-only; human applies to prod.
