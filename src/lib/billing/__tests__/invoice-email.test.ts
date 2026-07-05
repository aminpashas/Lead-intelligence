import { describe, it, expect } from 'vitest'
import { renderInvoiceEmailHtml, invoiceEmailSubject, invoicePeriodLabel } from '@/lib/billing/invoice-email'

const data = {
  practiceName: 'SF Dentistry',
  periodStart: '2026-07-01',
  periodEnd: '2026-08-01',
  lineItems: [
    { service: 'sms', quantity: 8063, unit: 'segments', billableCents: 26607.9 },
    { service: 'ai', quantity: 12, unit: 'AI actions', billableCents: 63 },
  ],
  usageBillableCents: 26670.9,
  platformFeeCents: 150000,
  totalCents: 176670.9,
}

describe('invoice-email', () => {
  it('labels the period by the start month', () => {
    expect(invoicePeriodLabel('2026-07-01')).toBe('July 2026')
    expect(invoiceEmailSubject(data)).toContain('July 2026')
  })

  it('renders totals and the practice name, and never leaks provider cost', () => {
    const html = renderInvoiceEmailHtml(data)
    expect(html).toContain('SF Dentistry')
    expect(html).toContain('$1,766.71') // total
    expect(html).toContain('$1,500.00') // platform fee
    expect(html).toContain('Total due')
    // customer-facing: must not expose our internal economics
    expect(html.toLowerCase()).not.toContain('provider cost')
    expect(html.toLowerCase()).not.toContain('markup')
  })
})
