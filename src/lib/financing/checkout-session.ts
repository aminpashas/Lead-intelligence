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
