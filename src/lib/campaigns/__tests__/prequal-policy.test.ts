import { describe, it, expect } from 'vitest'
import { resolvePrequalEligibility } from '@/lib/campaigns/prequal-policy'

describe('resolvePrequalEligibility (tighten-only precedence)', () => {
  it("'inherit' follows the org flag verbatim", () => {
    expect(resolvePrequalEligibility({ orgFlagOn: true, campaignMode: 'inherit' })).toBe(true)
    expect(resolvePrequalEligibility({ orgFlagOn: false, campaignMode: 'inherit' })).toBe(false)
  })

  it('null campaign (no active campaign) is treated as inherit', () => {
    expect(resolvePrequalEligibility({ orgFlagOn: true, campaignMode: null })).toBe(true)
    expect(resolvePrequalEligibility({ orgFlagOn: false, campaignMode: null })).toBe(false)
  })

  it("'disabled' vetoes even when the org flag is ON", () => {
    expect(resolvePrequalEligibility({ orgFlagOn: true, campaignMode: 'disabled' })).toBe(false)
    expect(resolvePrequalEligibility({ orgFlagOn: false, campaignMode: 'disabled' })).toBe(false)
  })

  it("'enabled' still requires the org flag (tighten-only: campaigns never widen)", () => {
    expect(resolvePrequalEligibility({ orgFlagOn: true, campaignMode: 'enabled' })).toBe(true)
    expect(resolvePrequalEligibility({ orgFlagOn: false, campaignMode: 'enabled' })).toBe(false)
  })
})
