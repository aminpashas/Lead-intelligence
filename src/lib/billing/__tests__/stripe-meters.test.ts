import { describe, it, expect, vi } from 'vitest'
import { buildMeterEvents, sendMeterEvents } from '@/lib/billing/stripe-meters'

describe('buildMeterEvents', () => {
  const base = { stripeCustomerId: 'cus_123', date: '2026-07-10', timestamp: 1_752_105_600 }

  it('emits one event per service with a positive rounded cent value', () => {
    const events = buildMeterEvents({ ...base, billable: { ai: 12.4, sms: 330, voice: 900, email: 3 } })
    expect(events).toHaveLength(4)
    const ai = events.find((e) => e.event_name === 'li_usage_ai')!
    expect(ai.payload).toEqual({ value: '12', stripe_customer_id: 'cus_123' })
  })

  it('drops services that are zero or round to zero', () => {
    const events = buildMeterEvents({ ...base, billable: { ai: 0.4, sms: 0, voice: 900 } })
    expect(events.map((e) => e.event_name)).toEqual(['li_usage_voice'])
  })

  it('builds a stable per-customer-per-service-per-day identifier for idempotency', () => {
    const events = buildMeterEvents({ ...base, billable: { sms: 500 } })
    expect(events[0].identifier).toBe('cus_123:sms:2026-07-10')
  })

  it('reports value as a string and passes through the timestamp', () => {
    const events = buildMeterEvents({ ...base, billable: { email: 7 } })
    expect(events[0].payload.value).toBe('7')
    expect(events[0].timestamp).toBe(1_752_105_600)
  })

  it('returns nothing when there is no billable usage', () => {
    expect(buildMeterEvents({ ...base, billable: {} })).toEqual([])
  })
})

describe('sendMeterEvents', () => {
  it('sends every event and counts successes', async () => {
    const create = vi.fn().mockResolvedValue({})
    const stripe = { billing: { meterEvents: { create } } } as never
    const events = buildMeterEvents({ stripeCustomerId: 'cus_1', date: '2026-07-10', timestamp: 1, billable: { sms: 100, ai: 50 } })
    const res = await sendMeterEvents(stripe, events)
    expect(res.sent).toBe(2)
    expect(res.errors).toEqual([])
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('isolates a per-event failure without aborting the rest', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('rate limited'))
    const stripe = { billing: { meterEvents: { create } } } as never
    const events = buildMeterEvents({ stripeCustomerId: 'cus_1', date: '2026-07-10', timestamp: 1, billable: { ai: 100, sms: 200 } })
    const res = await sendMeterEvents(stripe, events)
    expect(res.sent).toBe(1)
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0].message).toBe('rate limited')
  })
})
