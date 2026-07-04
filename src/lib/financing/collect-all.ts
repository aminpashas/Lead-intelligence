import type {
  LenderSlug, PaymentEstimate, LenderApplicationResponse, ApprovedTerms,
} from './types'
import type { LenderTermOption, LenderPrequalOffer, CoveragePlan } from './prequal-types'
import { allocateCoverage } from './allocate-coverage'

/**
 * Convert a lender's payment-estimate menu into distinct term options,
 * de-duplicating identical (apr:term:promo) combos while preserving order.
 */
export function estimatesToTerms(estimates: PaymentEstimate[]): LenderTermOption[] {
  const seen = new Set<string>()
  const terms: LenderTermOption[] = []
  for (const e of estimates) {
    const promo = e.promo_period_months ?? 0
    const key = `${e.apr}:${e.term_months}:${promo}`
    if (seen.has(key)) continue
    seen.add(key)
    terms.push({ apr: e.apr, term_months: e.term_months, promo_period_months: promo })
  }
  return terms
}

function termsFromApproved(terms: ApprovedTerms): LenderTermOption {
  return {
    apr: terms.apr,
    term_months: terms.term_months,
    promo_period_months: terms.promo_period_months ?? 0,
  }
}

/**
 * Map one lender's soft-pull prequal response (or absence of one) plus its
 * payment-estimate menu into a normalized LenderPrequalOffer.
 *
 * - approved  → decision 'approved', approved_amount from response, terms from
 *   the estimate menu (falling back to the response's own terms if the menu is empty).
 * - denied    → decision 'declined', no terms.
 * - null / pending / error → decision 'estimate' (link-only / indicative), terms
 *   from the estimate menu.
 */
export function mapToPrequalOffer(
  slug: LenderSlug,
  name: string,
  prequal: LenderApplicationResponse | null,
  estimates: PaymentEstimate[],
): LenderPrequalOffer {
  if (prequal?.status === 'approved') {
    const menuTerms = estimatesToTerms(estimates)
    const terms = menuTerms.length > 0
      ? menuTerms
      : (prequal.terms ? [termsFromApproved(prequal.terms)] : [])
    return {
      lender_slug: slug,
      lender_name: name,
      decision: 'approved',
      approved_amount: prequal.approved_amount ?? 0,
      terms,
    }
  }

  if (prequal?.status === 'denied') {
    return {
      lender_slug: slug,
      lender_name: name,
      decision: 'declined',
      approved_amount: 0,
      terms: [],
    }
  }

  return {
    lender_slug: slug,
    lender_name: name,
    decision: 'estimate',
    approved_amount: 0,
    terms: estimatesToTerms(estimates),
  }
}

export type CollectAllLender = {
  slug: LenderSlug
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
 * Orchestrate a collect-all prequal run: fan out across active lenders in
 * parallel, isolate any single lender's failure (never rejecting the batch),
 * persist the resulting offers, and compute a stacked coverage plan.
 */
export async function runCollectAllPrequal(args: CollectAllArgs): Promise<CollectAllResult> {
  const runId = args.runId ?? globalThis.crypto.randomUUID()

  const offers = await Promise.all(args.lenders.map(async (lender): Promise<LenderPrequalOffer> => {
    let prequal: LenderApplicationResponse | null = null
    if (lender.preQualify) {
      try {
        prequal = await lender.preQualify()
      } catch (err) {
        console.error(`[collect-all] preQualify failed for ${lender.slug}:`, err)
        prequal = null
      }
    }

    let estimates: PaymentEstimate[] = []
    if (lender.getPaymentEstimate) {
      try {
        estimates = await lender.getPaymentEstimate()
      } catch (err) {
        console.error(`[collect-all] getPaymentEstimate failed for ${lender.slug}:`, err)
        estimates = []
      }
    }

    return mapToPrequalOffer(lender.slug, lender.name, prequal, estimates)
  }))

  await args.persist(offers.map(offer => ({ offer, runId })))

  const plan = allocateCoverage(args.requestedAmount, offers)

  return { run_id: runId, offers, plan }
}
