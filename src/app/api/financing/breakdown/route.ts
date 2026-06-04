import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { buildFinancingBreakdown, type BreakdownOptions } from '@/lib/financing/calculator'
import { generatePatientFinancingSummary } from '@/lib/financing/patient-summary'
import type { LenderSlug } from '@/lib/financing/types'
import { applyDistributedRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'

const MAX_TREATMENT_VALUE = 250_000

const breakdownSchema = z.object({
  treatment_value: z.number().positive().max(MAX_TREATMENT_VALUE),
  insurance_estimate: z.number().nonnegative().max(MAX_TREATMENT_VALUE).optional(),
  patient_cash: z.number().nonnegative().max(MAX_TREATMENT_VALUE).optional(),
  hsa_fsa: z.number().nonnegative().max(MAX_TREATMENT_VALUE).optional(),
  other_credits: z.number().nonnegative().max(MAX_TREATMENT_VALUE).optional(),
  active_lenders: z.array(z.string()).optional(),
  first_name: z.string().max(100).optional(),
})

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
  // Rate limit (this endpoint calls the LLM, so it's abuse/cost-sensitive).
  const rlError = await applyDistributedRateLimit(request, RATE_LIMITS.api, 'financing-breakdown')
  if (rlError) return rlError

  // Require an authenticated org member — the previous handler was fully open.
  const supabase = await createClient()
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsed = breakdownSchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const options: BreakdownOptions = {
    treatment_value: parsed.data.treatment_value,
    insurance_estimate: parsed.data.insurance_estimate,
    patient_cash: parsed.data.patient_cash,
    hsa_fsa: parsed.data.hsa_fsa,
    other_credits: parsed.data.other_credits,
    active_lenders: parsed.data.active_lenders as LenderSlug[] | undefined,
  }

  const breakdown = buildFinancingBreakdown(options)

  // Generate AI patient summary
  let patientSummary: string | null = null
  try {
    patientSummary = await generatePatientFinancingSummary(breakdown, {
      firstName: parsed.data.first_name,
    })
  } catch {
    // Optional
  }

  return NextResponse.json({
    ...breakdown,
    patient_summary: patientSummary,
  })
}
