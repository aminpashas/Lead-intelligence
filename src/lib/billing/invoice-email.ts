/**
 * Usage-invoice email rendering. Pure (no I/O) so it's unit-testable. Customer-facing, so it shows
 * BILLABLE amounts (upcharge included) — never our provider cost or margin — plus the platform fee.
 */

export type InvoiceEmailLineItem = {
  service: string
  quantity: number
  unit: string
  billableCents: number
}

export type InvoiceEmailData = {
  practiceName: string
  periodStart: string // 'YYYY-MM-DD'
  periodEnd: string // 'YYYY-MM-DD' (exclusive)
  lineItems: InvoiceEmailLineItem[]
  usageBillableCents: number
  platformFeeCents: number
  totalCents: number
}

const SERVICE_LABEL: Record<string, string> = {
  ai: 'AI &amp; automation',
  sms: 'Text messaging',
  voice: 'Phone (voice)',
  email: 'Email',
}

const usd = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

/** 'YYYY-MM-DD' → 'July 2026' (uses the period start's month). */
export function invoicePeriodLabel(periodStart: string): string {
  return new Date(periodStart + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export function invoiceEmailSubject(data: Pick<InvoiceEmailData, 'periodStart'>): string {
  return `Your Lead Intelligence invoice — ${invoicePeriodLabel(data.periodStart)}`
}

export function renderInvoiceEmailHtml(data: InvoiceEmailData): string {
  const rows = data.lineItems
    .filter((li) => li.billableCents > 0 || li.quantity > 0)
    .map(
      (li) => `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #eee;color:#222;">
          ${SERVICE_LABEL[li.service] ?? li.service}
          <span style="color:#999;font-size:12px;"> · ${li.quantity.toLocaleString()} ${li.unit}</span>
        </td>
        <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;color:#222;font-variant-numeric:tabular-nums;">${usd(li.billableCents)}</td>
      </tr>`,
    )
    .join('')

  return `<!-- usage invoice -->
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#222;">
    <p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#999;margin:0 0 4px;">Invoice</p>
    <h1 style="font-size:24px;margin:0 0 2px;">${invoicePeriodLabel(data.periodStart)}</h1>
    <p style="color:#666;font-size:14px;margin:0 0 20px;">${data.practiceName}</p>

    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      ${rows}
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #eee;color:#222;">Usage subtotal</td>
        <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;color:#222;font-variant-numeric:tabular-nums;">${usd(data.usageBillableCents)}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #eee;color:#222;">Platform fee</td>
        <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;color:#222;font-variant-numeric:tabular-nums;">${usd(data.platformFeeCents)}</td>
      </tr>
      <tr>
        <td style="padding:12px 0;font-weight:600;color:#111;">Total due</td>
        <td style="padding:12px 0;text-align:right;font-weight:600;color:#111;font-size:18px;font-variant-numeric:tabular-nums;">${usd(data.totalCents)}</td>
      </tr>
    </table>

    <p style="color:#999;font-size:12px;line-height:1.6;margin-top:20px;">
      Covers activity from ${data.periodStart} to ${data.periodEnd}. Usage figures reflect AI, text
      messaging, and phone activity on your account, at your plan's service rate. Reply to this email
      with any questions.
    </p>
  </div>`
}
