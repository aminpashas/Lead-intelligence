import { describe, it, expect } from 'vitest'
import { chargeNoShowFeeForAppointment } from '@/lib/stripe/no-show-fee'

// These assertions exercise the guard rails that short-circuit BEFORE any Stripe
// call, so no Stripe/Supabase mock is needed — the dummy client is never touched.
const dummy = {} as never

describe('chargeNoShowFeeForAppointment — guards', () => {
  it('no customer on file → no_card_on_file (never calls Stripe)', async () => {
    const r = await chargeNoShowFeeForAppointment(dummy, 'org', {
      id: 'a1',
      stripe_customer_id: null,
      stripe_payment_method_id: 'pm_1',
      no_show_fee_cents: 5000,
    })
    expect(r).toEqual({ ok: false, error: 'no_card_on_file' })
  })

  it('no payment method on file → no_card_on_file', async () => {
    const r = await chargeNoShowFeeForAppointment(dummy, 'org', {
      id: 'a1',
      stripe_customer_id: 'cus_1',
      stripe_payment_method_id: null,
      no_show_fee_cents: 5000,
    })
    expect(r).toEqual({ ok: false, error: 'no_card_on_file' })
  })

  it('missing / non-positive fee amount → no_fee_amount', async () => {
    const base = { id: 'a1', stripe_customer_id: 'cus_1', stripe_payment_method_id: 'pm_1' }
    expect(await chargeNoShowFeeForAppointment(dummy, 'org', { ...base, no_show_fee_cents: null }))
      .toEqual({ ok: false, error: 'no_fee_amount' })
    expect(await chargeNoShowFeeForAppointment(dummy, 'org', { ...base, no_show_fee_cents: 0 }))
      .toEqual({ ok: false, error: 'no_fee_amount' })
  })
})
