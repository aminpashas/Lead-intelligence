import { createClient } from '@/lib/supabase/server'
import { ClosingBoard } from '@/components/crm/closing-board'
import { decryptLeadsPII } from '@/lib/encryption'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { isFocusedStaff } from '@/lib/auth/permissions'
import { redirect } from 'next/navigation'
import type { Lead } from '@/types/database'
import { closingForecast, daysSince, deriveClosingTemperature } from '@/lib/pipeline/closing'
import { rowCloseProbability, type ClosingBookRow, type ClosingRow } from '@/lib/pipeline/closing-book'

export default async function ClosingPage() {
  const supabase = await createClient()

  // Effective org honors an agency_admin's entered client account.
  const { orgId, role } = await resolveActiveOrg(supabase)
  if (!orgId) return null

  // In-closing is a sales workflow — same audience as the pipeline. Focused
  // (clinical) staff get the Today view; they don't work the closing book.
  if (isFocusedStaff(role || 'member')) redirect('/dashboard')

  // The board's population IS this table — a curated list, not a stage query.
  const { data: bookRows } = await supabase
    .from('closing_book')
    .select('*')
    .eq('organization_id', orgId)
    .order('sort_order', { ascending: true })

  const book = (bookRows || []) as ClosingBookRow[]

  // Hydrate the leads that rows link to (for Call/SMS/Email + the detail page).
  const leadIds = Array.from(new Set(book.map((r) => r.lead_id).filter(Boolean))) as string[]
  const leadById: Record<string, Lead> = {}
  if (leadIds.length) {
    const { data: rawLeads } = await supabase
      .from('leads')
      .select('*')
      .eq('organization_id', orgId)
      .in('id', leadIds)
    for (const lead of decryptLeadsPII(rawLeads || [])) leadById[lead.id] = lead
  }

  const nowMs = Date.now()

  const rows: ClosingRow[] = book.map((r) => {
    const daysSinceContact = daysSince(r.last_contact_at, nowMs)
    const derivedTemperature = deriveClosingTemperature(
      rowCloseProbability(r.close_probability, r.temperature ?? 'cold'),
      daysSinceContact
    )
    const effectiveTemp = r.temperature ?? derivedTemperature
    return {
      id: r.id,
      firstName: r.first_name,
      lastName: r.last_name,
      service: r.service,
      caseValue: r.case_value,
      statusRaw: r.status_raw,
      temperature: r.temperature,
      derivedTemperature,
      closeProbability: rowCloseProbability(r.close_probability, effectiveTemp),
      won: r.won,
      nextStep: r.next_step ?? '',
      daysSinceContact,
      leadId: r.lead_id,
      lead: r.lead_id ? leadById[r.lead_id] ?? null : null,
    }
  })

  // Hottest money first: highest probability-weighted case value at the top.
  rows.sort((a, b) => (b.caseValue ?? 0) * b.closeProbability - (a.caseValue ?? 0) * a.closeProbability)

  const forecast = closingForecast(
    rows.map((r) => ({
      treatmentValue: r.caseValue,
      closeProbability: r.closeProbability,
      daysSinceContact: r.daysSinceContact,
    }))
  )

  return (
    <div className="h-full animate-in fade-in-0 duration-500">
      <header className="mb-6 border-b border-aurea-border pb-6">
        <p className="aurea-eyebrow mb-2">Sales Pipeline</p>
        <h1 className="aurea-display text-[32px] text-aurea-ink sm:text-[40px]">In Closing</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-aurea-ink-2">
          Your curated closing book — every deal being actively worked to close, ranked by likely revenue.
        </p>
      </header>

      <ClosingBoard rows={rows} forecast={forecast} />
    </div>
  )
}
