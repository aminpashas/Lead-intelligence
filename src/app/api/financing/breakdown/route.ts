import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { buildFinancingBreakdown, type BreakdownOptions } from '@/lib/financing/calculator'
import { generatePatientFinancingSummary } from '@/lib/financing/patient-summary'
import type { LenderSlug } from '@/lib/financing/types'

/**
 * GET /api/financing/breakdown?lead_id=X
 * Auto-calculate financing breakdown from lead data.
 */
export async function GET(request: NextRequest) {
  const leadId = new URL(request.url).searchParams.get('lead_id')
  if (!leadId) {
    return NextResponse.json({ error: 'lead_id is required' }, { status: 400 })
  }

  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: lead, error } = await supabase
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .eq('organization_id', profile.organization_id)
    .single()

  if (error || !lead) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  }

  if (!lead.treatment_value) {
    return NextResponse.json(
      { error: 'Treatment value not set on this lead. Set treatment_value first.' },
      { status: 400 }
    )
  }

  // Get active lenders for this org
  const { data: lenderConfigs } = await supabase
    .from('financing_lender_configs')
    .select('lender_slug')
    .eq('organization_id', lead.organization_id)
    .eq('is_active', true)
    .order('priority_order')

  const activeLenders = lenderConfigs?.map(c => c.lender_slug as LenderSlug)

  const breakdown = buildFinancingBreakdown({
    treatment_value: lead.treatment_value,
    budget_range: lead.budget_range,
    has_dental_insurance: lead.has_dental_insurance,
    active_lenders: activeLenders?.length ? activeLenders : undefined,
  })

  // Generate AI patient summary
  let patientSummary: string | null = null
  try {
    patientSummary = await generatePatientFinancingSummary(breakdown, {
      firstName: lead.first_name,
      dentalCondition: lead.dental_condition,
    })
  } catch {
    // AI summary is optional, don't fail the whole request
  }

  return NextResponse.json({
    ...breakdown,
    patient_summary: patientSummary,
  })
}

/**
 * POST /api/financing/breakdown
 * Custom calculation with explicit overrides.
 */
export async function POST(request: NextRequest) {
  const body = await request.json() as Record<string, unknown>

  const treatmentValue = body.treatment_value as number
  if (!treatmentValue || treatmentValue <= 0) {
    return NextResponse.json({ error: 'treatment_value must be a positive number' }, { status: 400 })
  }

  const options: BreakdownOptions = {
    treatment_value: treatmentValue,
    insurance_estimate: typeof body.insurance_estimate === 'number' ? body.insurance_estimate : undefined,
    patient_cash: typeof body.patient_cash === 'number' ? body.patient_cash : undefined,
    hsa_fsa: typeof body.hsa_fsa === 'number' ? body.hsa_fsa : undefined,
    other_credits: typeof body.other_credits === 'number' ? body.other_credits : undefined,
    active_lenders: Array.isArray(body.active_lenders) ? body.active_lenders as LenderSlug[] : undefined,
  }

  const breakdown = buildFinancingBreakdown(options)

  // Generate AI patient summary
  let patientSummary: string | null = null
  try {
    patientSummary = await generatePatientFinancingSummary(breakdown, {
      firstName: body.first_name as string,
    })
  } catch {
    // Optional
  }

  return NextResponse.json({
    ...breakdown,
    patient_summary: patientSummary,
  })
}
