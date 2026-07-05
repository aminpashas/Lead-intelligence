import { createClient } from '@/lib/supabase/server'
import { InvoicesTable, type InvoiceRow } from '@/components/agency/invoices-table'

export const metadata = {
  title: 'Invoices | Lead Intelligence',
}

export default async function AgencyInvoicesPage() {
  const supabase = await createClient()

  const { data: rows } = await supabase
    .from('usage_invoices')
    .select('id, organization_id, period_start, period_end, usage_billable_cents, platform_fee_cents, total_cents, status, sent_at')
    .order('period_start', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(200)

  const invoices = (rows ?? []) as Omit<InvoiceRow, 'orgName'>[]
  const orgIds = Array.from(new Set(invoices.map((r) => r.organization_id)))
  const orgNames: Record<string, string> = {}
  if (orgIds.length > 0) {
    const { data: orgs } = await supabase.from('organizations').select('id, name').in('id', orgIds)
    for (const o of orgs ?? []) orgNames[o.id as string] = o.name as string
  }

  const withNames: InvoiceRow[] = invoices.map((r) => ({ ...r, orgName: orgNames[r.organization_id] ?? 'Unknown practice' }))

  return (
    <div className="animate-in fade-in-0 duration-500">
      <header className="border-b border-aurea-border pb-8">
        <p className="aurea-eyebrow mb-3">Cost Intelligence</p>
        <h1 className="aurea-display text-[40px] text-aurea-ink sm:text-[52px]">Invoices</h1>
        <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-aurea-ink-2">
          Usage bills per practice — usage re-bill plus the monthly platform fee. Draft an invoice from
          the pricing calculator, then issue, email, or void it here.
        </p>
      </header>

      <div className="mt-8">
        <InvoicesTable invoices={withNames} />
      </div>
    </div>
  )
}
