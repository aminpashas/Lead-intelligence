import { describe, it, expect } from 'vitest'
import { checkCompliance } from '@/lib/ai/compliance-filter'

const sms = { channel: 'sms' as const }

describe('checkCompliance — false credit-approval claims', () => {
  it('BLOCKS the fabricated approval from the real incident', () => {
    const body =
      "Great news, Amin! 🎉 You've been approved for $25,000 in dental financing through CareCredit — that's just $1042/mo. Let's get your consultation scheduled!"
    const res = checkCompliance(body, sms)
    expect(res.allowed).toBe(false)
    expect(res.reasons.some((r) => r.startsWith('false_approval_claim'))).toBe(true)
  })

  it.each([
    "you've been approved",
    'You are approved for financing!',
    "You're pre-approved for $10,000",
    'approved for $25,000',
    'Congratulations — your financing approval came through',
  ])('BLOCKS: %s', (body) => {
    expect(checkCompliance(`Hi there, ${body} today.`, sms).allowed).toBe(false)
  })

  it.each([
    '✅ Flexible terms, approvals for all credit types', // generic marketing, not a personal claim
    'Most of our patients get approved for monthly payments.',
    'We can usually get you approved for payments in 20 minutes.',
    'Approval odds are best above 650.',
  ])('ALLOWS (no false-approval block): %s', (body) => {
    const res = checkCompliance(`Hi there! ${body}`, sms)
    expect(res.reasons.some((r) => r.startsWith('false_approval_claim'))).toBe(false)
  })
})
