import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { resolveSmartListLeads } from '@/lib/campaigns/smart-list-resolver'
import { computeEligibility, type LeadConsentRow } from '@/lib/campaigns/eligibility'

const SAMPLE_CAP = 2000

// GET /api/smart-lists/:id/eligibility — consent/eligibility breakdown for a Smart
// List, so a broadcast can show how many recipients are actually reachable (and why
// the rest are excluded) before sending. Sampled to SAMPLE_CAP leads.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: smartList } = await supabase
    .from('smart_lists')
    .select('criteria')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (!smartList) return NextResponse.json({ error: 'Smart List not found' }, { status: 404 })

  const { leadIds, count } = await resolveSmartListLeads(supabase, orgId, smartList.criteria, {
    limit: SAMPLE_CAP,
  })

  const empty = { total: 0, eligible: 0, no_consent: 0, opted_out: 0, no_contact: 0 }
  if (leadIds.length === 0) {
    return NextResponse.json({ sms: empty, email: empty, list_total: count, sampled: 0, capped: false })
  }

  const { data: rows } = await supabase
    .from('leads')
    .select('sms_consent, sms_opt_out, email_consent, email_opt_out, phone_formatted, email')
    .in('id', leadIds.slice(0, SAMPLE_CAP))
    .eq('organization_id', orgId)

  const leads = (rows || []) as LeadConsentRow[]

  return NextResponse.json({
    sms: computeEligibility(leads, 'sms'),
    email: computeEligibility(leads, 'email'),
    list_total: count,
    sampled: leads.length,
    capped: count > leads.length,
  })
}
