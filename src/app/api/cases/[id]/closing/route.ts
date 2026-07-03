import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { hasPermission } from '@/lib/auth/permissions'
import {
  getTreatmentClosingByCase,
  getClosingProgress,
  advanceStepByCase,
  createTreatmentClosing,
} from '@/lib/treatment/treatment-closing'

/**
 * GET  /api/cases/[id]/closing — Closing state + progress + related records
 * POST /api/cases/[id]/closing — Advance a closing step (manual override path;
 *   webhooks/booking advance steps automatically through the same engine)
 */

const advanceSchema = z.object({
  step: z.enum([
    'treatment_plan_presented',
    'contract_signed',
    'financing_funded',
    'consent_signed',
    'preop_instructions_sent',
    'surgery_scheduled',
    'records_confirmed',
  ]),
  data: z.object({
    contract_amount: z.number().positive().optional(),
    deposit_amount: z.number().positive().optional(),
    non_refundable_acknowledged: z.boolean().optional(),
    financing_type: z.enum(['loan', 'in_house', 'cash', 'insurance']).optional(),
    financing_monthly_payment: z.number().positive().optional(),
    consent_forms: z.array(z.string().max(200)).max(20).optional(),
    preop_sent_via: z.enum(['sms', 'email', 'both']).optional(),
    surgery_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    surgery_time: z.string().regex(/^\d{2}:\d{2}/).optional(),
    surgery_type: z.string().max(200).optional(),
    estimated_duration_hours: z.number().positive().max(24).optional(),
    records_checklist: z.record(z.string(), z.boolean()).optional(),
    notes: z.string().max(2000).optional(),
  }).default({}),
})

async function authorize(request: NextRequest, caseId: string) {
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single()
  if (!profile || !hasPermission(profile.role, 'cases:read')) {
    return { error: NextResponse.json({ error: 'Access denied' }, { status: 403 }) }
  }

  const { data: caseRow } = await supabase
    .from('clinical_cases')
    .select('id, organization_id, lead_id, status, patient_accepted_at')
    .eq('id', caseId)
    .eq('organization_id', orgId)
    .single()
  if (!caseRow) return { error: NextResponse.json({ error: 'Case not found' }, { status: 404 }) }

  return { supabase, orgId, user, profile, caseRow }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params
  const auth = await authorize(_request, caseId)
  if ('error' in auth) return auth.error
  const { supabase, caseRow } = auth

  const closing = await getTreatmentClosingByCase(supabase, caseId)

  // Related records for the Closing tab cards
  const [{ data: contract }, { data: labOrders }, { data: preopForms }, { data: surgeryAppt }, financing] =
    await Promise.all([
      supabase
        .from('patient_contracts')
        .select('id, status, contract_amount, deposit_amount, financing_type, sent_at, signed_at, approved_at')
        .eq('clinical_case_id', caseId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('lab_orders')
        .select('*')
        .eq('clinical_case_id', caseId)
        .order('created_at', { ascending: false }),
      supabase
        .from('preop_forms')
        .select('id, status, title, sent_via, sent_at, first_viewed_at, acknowledged_at, share_token')
        .eq('clinical_case_id', caseId)
        .order('created_at', { ascending: false }),
      supabase
        .from('appointments')
        .select('id, type, status, scheduled_at, duration_minutes, location, carestack_sync_status')
        .eq('type', 'surgery')
        .contains('metadata', { case_id: caseId })
        .order('scheduled_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      caseRow.lead_id
        ? supabase
            .from('financing_applications')
            .select('id, status, approved_lender_slug, requested_amount, approved_amount, approved_terms, completed_at')
            .eq('lead_id', caseRow.lead_id)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ])

  return NextResponse.json({
    closing,
    progress: closing ? getClosingProgress(closing) : null,
    contract: contract ?? null,
    financing: financing?.data ?? null,
    lab_orders: labOrders ?? [],
    preop_forms: preopForms ?? [],
    surgery_appointment: surgeryAppt ?? null,
  })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params
  const auth = await authorize(request, caseId)
  if ('error' in auth) return auth.error
  const { supabase, orgId, caseRow } = auth

  const parsed = advanceSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })
  }

  // Ensure a closing exists (staff can start the closing even before the
  // patient accepts through the portal — e.g. verbal acceptance in office)
  let closing = await getTreatmentClosingByCase(supabase, caseId)
  if (!closing) {
    closing = await createTreatmentClosing(supabase, {
      organizationId: orgId,
      leadId: caseRow.lead_id,
      clinicalCaseId: caseId,
    })
    if (!closing) {
      return NextResponse.json({ error: 'Could not create closing record' }, { status: 500 })
    }
    // Starting the closing pulls the case out of the clinical stages
    if (['patient_review', 'treatment_planning', 'diagnosis'].includes(caseRow.status)) {
      await supabase.from('clinical_cases').update({ status: 'accepted' }).eq('id', caseId)
    }
  }

  const result = await advanceStepByCase(supabase, caseId, parsed.data.step, parsed.data.data)
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 422 })
  }

  return NextResponse.json({
    closing: result.closing,
    progress: result.closing ? getClosingProgress(result.closing) : null,
  })
}

/**
 * PATCH — update the records checklist (and notes) WITHOUT advancing the step.
 * When every checklist item flips true, the records_confirmed step advances
 * automatically and the case becomes ready_for_surgery.
 */
const patchSchema = z.object({
  records_checklist: z.record(z.string(), z.boolean()).optional(),
  notes: z.string().max(2000).optional(),
})

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params
  const auth = await authorize(request, caseId)
  if ('error' in auth) return auth.error
  const { supabase } = auth

  const parsed = patchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })
  }

  const closing = await getTreatmentClosingByCase(supabase, caseId)
  if (!closing) {
    return NextResponse.json({ error: 'No treatment closing record found for this case.' }, { status: 404 })
  }

  const mergedChecklist = { ...closing.records_checklist, ...(parsed.data.records_checklist ?? {}) }
  const updates: Record<string, unknown> = { records_checklist: mergedChecklist }
  if (parsed.data.notes) {
    updates.notes = closing.notes
      ? `${closing.notes}\n[${new Date().toLocaleDateString()}] ${parsed.data.notes}`
      : `[${new Date().toLocaleDateString()}] ${parsed.data.notes}`
  }

  const { data: updated, error } = await supabase
    .from('treatment_closings')
    .update(updates)
    .eq('id', closing.id)
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // All records in? Complete the step (idempotent — advanceClosing dedupes).
  const allDone = Object.values(mergedChecklist).every(Boolean)
  if (allDone && !closing.records_confirmed_at) {
    const result = await advanceStepByCase(supabase, caseId, 'records_confirmed', {
      records_checklist: mergedChecklist,
    })
    if (result.success && result.closing) {
      return NextResponse.json({ closing: result.closing, progress: getClosingProgress(result.closing) })
    }
  }

  return NextResponse.json({ closing: updated, progress: getClosingProgress(updated) })
}
