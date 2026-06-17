import { describe, it, expect } from 'vitest'
import {
  buildManualOutcomeWrites,
  canRecordOutcome,
  ManualOutcomeError,
} from '@/lib/financing/manual-outcome'

const NOW = '2026-06-17T12:00:00.000Z'

describe('canRecordOutcome', () => {
  it('allows on awaiting states', () => {
    expect(canRecordOutcome('link_sent')).toBe(true)
    expect(canRecordOutcome('pending')).toBe(true)
    expect(canRecordOutcome('submitted')).toBe(true)
  })
  it('blocks on terminal states', () => {
    expect(canRecordOutcome('approved')).toBe(false)
    expect(canRecordOutcome('denied')).toBe(false)
    expect(canRecordOutcome('error')).toBe(false)
  })
})

describe('buildManualOutcomeWrites — approval', () => {
  it('marks submission + application approved and flips lead', () => {
    const w = buildManualOutcomeWrites(
      { outcome: 'approved', approved_amount: 18000, apr: 9.99, term_months: 36, monthly_payment: 560 },
      'cherry',
      NOW
    )
    expect(w.submission.status).toBe('approved')
    expect(w.submission.responded_at).toBe(NOW)
    expect(w.application).not.toBeNull()
    expect(w.application!.approved_lender_slug).toBe('cherry')
    expect(w.application!.approved_amount).toBe(18000)
    expect(w.application!.status).toBe('approved')
    expect(w.leadFinancingApproved).toBe(true)
  })

  it('rejects an approval without a positive amount', () => {
    expect(() => buildManualOutcomeWrites({ outcome: 'approved' }, 'cherry', NOW)).toThrow(ManualOutcomeError)
    expect(() => buildManualOutcomeWrites({ outcome: 'approved', approved_amount: 0 }, 'cherry', NOW)).toThrow(
      ManualOutcomeError
    )
  })
})

describe('buildManualOutcomeWrites — denial', () => {
  it('records on the submission only; does not deny the whole application', () => {
    const w = buildManualOutcomeWrites({ outcome: 'denied', denial_reason: 'credit' }, 'alpheon', NOW)
    expect(w.submission.status).toBe('denied')
    expect((w.submission.response_data as { denial_reason: string }).denial_reason).toBe('credit')
    expect(w.application).toBeNull()
    expect(w.leadFinancingApproved).toBeNull()
  })
})
