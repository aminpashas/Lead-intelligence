import { describe, it, expect } from 'vitest'
import { buildSmsCostEvent, buildVoiceCostEvent } from '@/lib/billing/cost-events'

describe('buildSmsCostEvent', () => {
  it('estimates cost from the body, applies the SMS markup, and marks it estimated', () => {
    const row = buildSmsCostEvent({
      organizationId: 'org-1',
      externalId: 'SM123',
      body: 'x'.repeat(200), // 2 segments
      status: 'estimated',
      leadId: 'lead-9',
    })
    expect(row.service).toBe('sms')
    expect(row.status).toBe('estimated')
    expect(row.quantity).toBe(2)
    expect(row.unit).toBe('segments')
    expect(row.external_id).toBe('SM123')
    expect(row.source_table).toBe('messages')
    expect(row.cost_cents).toBeCloseTo(2 * 1.1, 6) // 2 segments × 1.1¢
    expect(row.billable_cents).toBeCloseTo(2 * 1.1 * 3, 6) // × (1 + 200%) = 3× cost
    expect(row.markup_pct).toBe(200)
    expect(row.metadata).toMatchObject({ lead_id: 'lead-9' })
  })

  it('uses the provider cost + segments verbatim when finalizing', () => {
    const row = buildSmsCostEvent({
      organizationId: 'org-1',
      externalId: 'SM123',
      segments: 1,
      costCents: 0.79, // Twilio actual
      status: 'final',
    })
    expect(row.status).toBe('final')
    expect(row.quantity).toBe(1)
    expect(row.cost_cents).toBeCloseTo(0.79, 6)
    expect(row.billable_cents).toBeCloseTo(0.79 * 3, 6)
  })

  it('honors a per-practice markup override', () => {
    const row = buildSmsCostEvent({
      organizationId: 'org-1',
      externalId: 'SM9',
      segments: 1,
      costCents: 1,
      status: 'final',
      markup: { markups: { sms: 10 } },
    })
    expect(row.markup_pct).toBe(10)
    expect(row.billable_cents).toBeCloseTo(1.1, 6)
  })
})

describe('buildVoiceCostEvent', () => {
  it('records the Retell cost, applies the voice markup, and is always final', () => {
    const row = buildVoiceCostEvent({
      organizationId: 'org-2',
      externalId: 'call_abc',
      seconds: 120,
      costCents: 15, // Retell combined_cost
    })
    expect(row.service).toBe('voice')
    expect(row.status).toBe('final')
    expect(row.quantity).toBe(120)
    expect(row.unit).toBe('seconds')
    expect(row.source_table).toBe('voice_calls')
    expect(row.cost_cents).toBe(15)
    expect(row.billable_cents).toBeCloseTo(15 * 3, 6) // 200% voice markup = 3× cost
    expect(row.markup_pct).toBe(200)
  })
})
