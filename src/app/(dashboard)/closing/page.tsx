import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ClosingBoard, type ClosingMeta } from '@/components/crm/closing-board'
import { decryptLeadsPII } from '@/lib/encryption'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { isFocusedStaff } from '@/lib/auth/permissions'
import { computeCloseBaseRate, scoreCloseProbability } from '@/lib/pipeline/close-probability'
import { classifyLeadServiceLines } from '@/lib/leads/service-line'
import {
  CLOSING_STAGE_SLUGS,
  closingForecast,
  daysSince,
  deriveClosingTemperature,
} from '@/lib/pipeline/closing'

export default async function ClosingPage() {
  const supabase = await createClient()

  // Effective org honors an agency_admin's entered client account.
  const { orgId, role } = await resolveActiveOrg(supabase)
  if (!orgId) return null

  // In-closing is a sales workflow — same audience as the pipeline. Focused
  // (clinical) staff get the Today view; they don't work the closing book.
  if (isFocusedStaff(role || 'member')) redirect('/dashboard')

  // The two stages that define "in closing" → their ids for this org.
  const { data: closingStages } = await supabase
    .from('pipeline_stages')
    .select('id, name, slug')
    .eq('organization_id', orgId)
    .in('slug', CLOSING_STAGE_SLUGS as unknown as string[])

  const stageIds = (closingStages || []).map((s) => s.id)
  const stageNameById: Record<string, string> = {}
  for (const s of closingStages || []) stageNameById[s.id] = s.name

  // Org-wide statuses give an accurate base conversion rate; scoring only the
  // closing-stage sample would bias the base rate low (none have converted yet).
  const { data: statusRows } = await supabase
    .from('leads')
    .select('status')
    .eq('organization_id', orgId)
  const baseRate = computeCloseBaseRate((statusRows || []).map((r) => r.status))

  // The deals actually in closing.
  const { data: rawLeads } = stageIds.length
    ? await supabase
        .from('leads')
        .select('*')
        .eq('organization_id', orgId)
        .in('stage_id', stageIds)
        .not('status', 'in', '("disqualified","lost")')
    : { data: [] }

  const leads = decryptLeadsPII(rawLeads || [])
  const nowMs = Date.now()

  const meta: Record<string, ClosingMeta> = {}
  for (const lead of leads) {
    const closeProbability = scoreCloseProbability(lead, baseRate, nowMs)
    const daysSinceContact = daysSince(lead.last_contacted_at, nowMs)
    meta[lead.id] = {
      closeProbability,
      daysSinceContact,
      serviceLines: classifyLeadServiceLines(lead),
      stageName: lead.stage_id ? stageNameById[lead.stage_id] ?? '—' : '—',
      derivedTemperature: deriveClosingTemperature(closeProbability, daysSinceContact),
    }
  }

  // Hottest money first: highest probability-weighted case value at the top.
  leads.sort((a, b) => {
    const wa = (a.treatment_value ?? 0) * meta[a.id].closeProbability
    const wb = (b.treatment_value ?? 0) * meta[b.id].closeProbability
    return wb - wa
  })

  const forecast = closingForecast(
    leads.map((l) => ({
      treatmentValue: l.treatment_value,
      closeProbability: meta[l.id].closeProbability,
      daysSinceContact: meta[l.id].daysSinceContact,
    }))
  )

  return (
    <div className="h-full animate-in fade-in-0 duration-500">
      <header className="mb-6 border-b border-aurea-border pb-6">
        <p className="aurea-eyebrow mb-2">Sales Pipeline</p>
        <h1 className="aurea-display text-[32px] text-aurea-ink sm:text-[40px]">In Closing</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-aurea-ink-2">
          Every deal that&apos;s been presented and is being worked to close — ranked by likely revenue.
        </p>
      </header>

      <ClosingBoard leads={leads} meta={meta} forecast={forecast} />
    </div>
  )
}
