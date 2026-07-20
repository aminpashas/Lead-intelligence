import { describe, it, expect } from 'vitest'
import { preCallCheck } from './call-manager'

/** Minimal chainable stub returning a single lead row from .single(). */
function stubClientWithLead(lead: Record<string, unknown>) {
  const chain: any = { select: () => chain, eq: () => chain, single: () => Promise.resolve({ data: lead, error: null }) }
  return { from: () => chain } as any
}

describe('preCallCheck hold gate', () => {
  it('denies with on_hold when the lead is held into the future', async () => {
    const client = stubClientWithLead({
      id: 'l1', first_name: 'A', phone_formatted: null, phone: '+15551234567',
      voice_opt_out: false, do_not_call: false,
      hold_until: '2999-01-01T00:00:00Z', timezone: 'America/New_York',
    })
    const res = await preCallCheck(client, 'l1', 'org1')
    expect(res.allowed).toBe(false)
    expect((res as any).reason).toBe('on_hold')
  })
})
