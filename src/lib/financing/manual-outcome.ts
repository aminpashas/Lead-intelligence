/**
 * Manual financing outcome (Phase 2.B — honest link-partner path).
 *
 * Link lenders (Cherry, Alpheon, Proceed, LendingClub) have no API/webhook, so a
 * sent application sits at status 'link_sent' with no programmatic outcome. Staff
 * read the decision from the lender portal and record it here. This module holds
 * the pure mapping from a recorded decision → the DB writes, so it's testable
 * without a DB.
 */

export type ManualOutcome = 'approved' | 'denied'

export interface ManualOutcomeInput {
  outcome: ManualOutcome
  approved_amount?: number
  apr?: number
  term_months?: number
  monthly_payment?: number
  denial_reason?: string
}

export interface OutcomeWrites {
  /** Update for the financing_submissions row. */
  submission: Record<string, unknown>
  /** Update for the parent financing_applications row, or null to leave it. */
  application: Record<string, unknown> | null
  /** New value for leads.financing_approved, or null to leave it. */
  leadFinancingApproved: boolean | null
}

export class ManualOutcomeError extends Error {}

/**
 * Build the DB writes for a manually-recorded link-lender decision.
 * A single lender's denial does NOT deny the whole application (other lenders may
 * still be outstanding in a manual flow); only an approval is terminal.
 */
export function buildManualOutcomeWrites(
  input: ManualOutcomeInput,
  lenderSlug: string,
  now: string = new Date().toISOString()
): OutcomeWrites {
  if (input.outcome === 'approved') {
    const amount = input.approved_amount
    if (typeof amount !== 'number' || !(amount > 0)) {
      throw new ManualOutcomeError('approved_amount must be a positive number for an approval')
    }
    const terms = {
      apr: input.apr ?? null,
      term_months: input.term_months ?? null,
      monthly_payment: input.monthly_payment ?? null,
    }
    return {
      submission: {
        status: 'approved',
        response_data: { approved_amount: amount, ...terms, recorded: 'manual' },
        responded_at: now,
      },
      application: {
        status: 'approved',
        approved_lender_slug: lenderSlug,
        approved_amount: amount,
        approved_terms: terms,
        completed_at: now,
        updated_at: now,
      },
      leadFinancingApproved: true,
    }
  }

  // Denied — record on the submission only.
  return {
    submission: {
      status: 'denied',
      response_data: { denial_reason: input.denial_reason ?? null, recorded: 'manual' },
      responded_at: now,
    },
    application: null,
    leadFinancingApproved: null,
  }
}

/** A submission can only receive a manual outcome while it's awaiting one. */
export function canRecordOutcome(submissionStatus: string): boolean {
  return submissionStatus === 'link_sent' || submissionStatus === 'pending' || submissionStatus === 'submitted'
}
