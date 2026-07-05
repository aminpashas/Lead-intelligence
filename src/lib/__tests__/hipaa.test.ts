import { describe, it, expect } from 'vitest'
import { detectPHI, scrubPHI, checkResponseCompliance, buildSafeLeadContext } from '../ai/hipaa'

describe('detectPHI', () => {
  it('detects phone numbers', () => {
    const detections = detectPHI('Call me at 415-886-1942')
    expect(detections.some(d => d.category === 'phone')).toBe(true)
  })

  it('detects email addresses', () => {
    const detections = detectPHI('Email me at john@example.com')
    expect(detections.some(d => d.category === 'email')).toBe(true)
  })

  it('detects SSN patterns', () => {
    const detections = detectPHI('My SSN is 123-45-6789')
    expect(detections.some(d => d.category === 'ssn')).toBe(true)
  })

  it('returns empty for clean text', () => {
    const detections = detectPHI('I need dental implants for my upper teeth')
    expect(detections).toHaveLength(0)
  })
})

describe('scrubPHI', () => {
  it('replaces phone numbers with placeholder', () => {
    const scrubbed = scrubPHI('Call me at 415-886-1942 please')
    expect(scrubbed).toContain('[PHONE_REDACTED]')
    expect(scrubbed).not.toContain('415-886-1942')
  })

  it('replaces email addresses', () => {
    const scrubbed = scrubPHI('My email is test@example.com')
    expect(scrubbed).toContain('[EMAIL_REDACTED]')
    expect(scrubbed).not.toContain('test@example.com')
  })
})

describe('checkResponseCompliance', () => {
  it('flags medical diagnoses', () => {
    const issues = checkResponseCompliance('Based on your symptoms, you have periodontal disease.')
    expect(issues.some(i => i.category === 'medical_advice')).toBe(true)
  })

  it('flags treatment guarantees', () => {
    const issues = checkResponseCompliance('This procedure has a 100% success rate and zero risk.')
    expect(issues.some(i => i.category === 'treatment_guarantee')).toBe(true)
  })

  it('flags PHI solicitation', () => {
    const issues = checkResponseCompliance('Please send me your social security number for our records.')
    expect(issues.some(i => i.category === 'phi_solicitation')).toBe(true)
  })

  it('passes compliant responses', () => {
    const issues = checkResponseCompliance('I would recommend scheduling a consultation with our doctor to discuss your options.')
    expect(issues).toHaveLength(0)
  })
})

describe('buildSafeLeadContext', () => {
  it('includes first name only', () => {
    const ctx = buildSafeLeadContext({
      first_name: 'John',
      last_name: 'Smith',
      email: 'john@test.com',
      phone: '555-1234',
    })
    expect(ctx).toContain('John')
    expect(ctx).not.toContain('Smith')
    expect(ctx).not.toContain('john@test.com')
    expect(ctx).not.toContain('555-1234')
  })

  it('includes clinical data', () => {
    const ctx = buildSafeLeadContext({
      first_name: 'Jane',
      dental_condition: 'missing_all_upper',
      financing_interest: 'cash_pay',
    })
    expect(ctx).toContain('missing all upper')
    expect(ctx).toContain('cash pay')
  })

  it('withholds Tier-1 case data when identity is not verified', () => {
    const lead = {
      first_name: 'Jane',
      dental_condition: 'missing_all_upper',
      financing_interest: 'cash_pay',
      budget_range: '20k_30k',
    }
    const ctx = buildSafeLeadContext(lead, { disclosePHI: false })
    // First name (Tier-0) still present so the agent can greet naturally...
    expect(ctx).toContain('Jane')
    // ...but nothing case-specific.
    expect(ctx).not.toContain('missing all upper')
    expect(ctx).not.toContain('cash pay')
    expect(ctx).not.toContain('20k')
    expect(ctx).toContain('identity not yet verified')
  })

  it('includes Tier-1 data when disclosePHI is true (default preserved)', () => {
    const lead = { first_name: 'Jane', dental_condition: 'missing_all_upper' }
    expect(buildSafeLeadContext(lead, { disclosePHI: true })).toContain('missing all upper')
    expect(buildSafeLeadContext(lead)).toContain('missing all upper')
  })
})
