import { describe, it, expect } from 'vitest'
import type { Lead } from '@/types/database'
import { buildQualificationStatus, isDiscoveryComplete } from '@/lib/ai/agent-types'
import { buildPricingIntegrityBlock } from '@/lib/ai/pricing-integrity'

function lead(overrides: Partial<Lead>): Partial<Lead> {
  return { id: 'lead-1', organization_id: 'org-1', ...overrides }
}

describe('buildQualificationStatus', () => {
  it('treats NULL and "unknown" credit as not-known', () => {
    expect(buildQualificationStatus(lead({})).credit.known).toBe(false)
    expect(buildQualificationStatus(lead({ credit_range: 'unknown' })).credit.known).toBe(false)
    expect(buildQualificationStatus(lead({ credit_range: 'good' })).credit.known).toBe(true)
  })

  it('counts a stated timeline_note as a known timeline (no booking required)', () => {
    expect(buildQualificationStatus(lead({})).timeline.known).toBe(false)
    expect(buildQualificationStatus(lead({ timeline_note: 'wants to start next month' })).timeline.known).toBe(true)
  })
})

describe('isDiscoveryComplete (soft gate)', () => {
  it('is false until goal + timeline + a financial signal are all known', () => {
    // Nothing known
    expect(isDiscoveryComplete(buildQualificationStatus(lead({})))).toBe(false)
    // Goal only
    expect(isDiscoveryComplete(buildQualificationStatus(lead({ dental_condition: 'missing_all_both' })))).toBe(false)
    // Goal + timeline, no financial signal
    expect(
      isDiscoveryComplete(
        buildQualificationStatus(lead({ dental_condition: 'missing_all_both', timeline_note: 'ASAP' }))
      )
    ).toBe(false)
  })

  it('is true once goal + timeline + credit are known', () => {
    const status = buildQualificationStatus(
      lead({ dental_condition: 'missing_all_both', timeline_note: 'ASAP', credit_range: 'good' })
    )
    expect(isDiscoveryComplete(status)).toBe(true)
  })

  it('accepts financing preference as the financial signal in place of credit', () => {
    const status = buildQualificationStatus(
      lead({ dental_condition: 'failing_teeth', timeline_note: 'a few months', financing_interest: 'financing_needed' })
    )
    expect(isDiscoveryComplete(status)).toBe(true)
  })
})

describe('buildPricingIntegrityBlock', () => {
  it('forbids all cost talk before discovery is complete', () => {
    const block = buildPricingIntegrityBlock({ configuredRange: '$250–350/mo per arch', discoveryComplete: false })
    expect(block).toMatch(/NEVER invent/i)
    expect(block).toMatch(/DISCOVERY IS NOT YET COMPLETE/i)
    // The configured range must NOT be surfaced yet.
    expect(block).not.toContain('$250–350/mo per arch')
  })

  it('surfaces the configured range as a range once discovery is complete', () => {
    const block = buildPricingIntegrityBlock({ configuredRange: '$250–350/mo per arch', discoveryComplete: true })
    expect(block).toContain('$250–350/mo per arch')
    expect(block).toMatch(/range, not a quote/i)
  })

  it('stays qualitative when no range is configured — never invents one', () => {
    const block = buildPricingIntegrityBlock({ configuredRange: null, discoveryComplete: true })
    expect(block).toMatch(/DO NOT state numbers/i)
  })

  it('permits citing real figures only when real financing data exists', () => {
    const withData = buildPricingIntegrityBlock({ discoveryComplete: true, hasRealFinancingData: true })
    expect(withData).toMatch(/you may cite those exact numbers/i)
    const withoutData = buildPricingIntegrityBlock({ discoveryComplete: true, hasRealFinancingData: false })
    expect(withoutData).toMatch(/NOT available for this patient/i)
  })

  it('forbids proactively naming third-party lenders on every path', () => {
    for (const discoveryComplete of [false, true]) {
      const block = buildPricingIntegrityBlock({ configuredRange: '$250–350/mo', discoveryComplete })
      expect(block).toMatch(/FINANCING DISCLOSURE DISCIPLINE/i)
      expect(block).toMatch(/Do NOT proactively name specific third-party lenders/i)
      expect(block).toContain('CareCredit')
      expect(block).toContain('Proceed Finance')
      // Never volunteer credit-tier framing about the patient.
      expect(block).toMatch(/NEVER volunteer credit-tier framing/i)
    }
  })
})

import { executeAgentTool } from '@/lib/autopilot/agent-tools'

describe('send_financing_link qualification gate (code-enforced)', () => {
  // The Closer reaches this tool via stage routing, but stage is set by external
  // GHL sync and can be wrong. The gate must refuse — in code, not just prompt —
  // when the lead has not actually been qualified. The refusal path returns
  // before any Supabase/SMS call, so a throwaway client is never touched.
  const throwaway = {} as never
  const baseContext = {
    organization_id: 'org-1',
    lead_id: 'lead-1',
    conversation_id: 'conv-1',
    channel: 'sms',
    disclose_phi: true, // bypass the separate HIPAA identity gate to isolate this one
  }

  it('refuses to send when the lead is unqualified (the screenshot failure)', async () => {
    const result = await executeAgentTool(throwaway, 'send_financing_link', {}, {
      ...baseContext,
      lead: { id: 'lead-1', organization_id: 'org-1', status: 'financing' }, // closer-stage, zero discovery
    })
    expect(result.success).toBe(false)
    expect(result.data).not.toHaveProperty('financing_url')
    // Must instruct the model NOT to claim a link was sent.
    expect(result.message).toMatch(/do NOT send a financing link or tell them one was sent/i)
  })
})
