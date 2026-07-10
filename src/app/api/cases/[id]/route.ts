import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /api/cases/[id] — Fetch full case with files, diagnosis, treatment plan
 * PATCH /api/cases/[id] — Update case (status, notes, assignment)
 */

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: caseData, error } = await supabase
    .from('clinical_cases')
    .select(`
      *,
      case_files (*),
      case_diagnosis (*),
      case_treatment_plans (*),
      creator:user_profiles!clinical_cases_created_by_fkey (id, full_name, role, avatar_url),
      assigned_doctor:user_profiles!clinical_cases_assigned_doctor_id_fkey (id, full_name, role, avatar_url, specialty),
      treatment_closings!treatment_closings_clinical_case_id_fkey (
        id, current_step, steps_completed, contract_signed_at, contract_amount,
        financing_type, financing_funded_at, consent_signed_at,
        preop_instructions_sent_at, surgery_date, surgery_time,
        records_checklist, records_confirmed_at,
        dion_handoff_at, dion_surgery_status, dion_surgery_date, dion_synced_at
      ),
      lab_orders!lab_orders_clinical_case_id_fkey (
        id, lab_provider, status, external_case_id, external_case_number,
        submitted_at, updated_at
      )
    `)
    .eq('id', id)
    .single()

  if (error || !caseData) {
    return NextResponse.json({ error: 'Case not found' }, { status: 404 })
  }

  // Newest non-terminal lab order (mirrors the list route).
  const TERMINAL_LAB = new Set(['cancelled', 'error'])
  const orders = Array.isArray(caseData.lab_orders) ? caseData.lab_orders : []
  const byRecency = [...orders].sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
  const labOrder = byRecency.find((o) => !TERMINAL_LAB.has(o.status)) ?? byRecency[0] ?? null

  // Restructure joins
  const result = {
    ...caseData,
    files: caseData.case_files || [],
    diagnosis: Array.isArray(caseData.case_diagnosis)
      ? caseData.case_diagnosis[0] || null
      : caseData.case_diagnosis || null,
    treatment_plan: Array.isArray(caseData.case_treatment_plans)
      ? caseData.case_treatment_plans[0] || null
      : caseData.case_treatment_plans || null,
    closing: Array.isArray(caseData.treatment_closings)
      ? caseData.treatment_closings[0] || null
      : caseData.treatment_closings || null,
    lab_order: labOrder,
  }
  delete result.case_files
  delete result.case_diagnosis
  delete result.case_treatment_plans
  delete result.treatment_closings
  delete result.lab_orders

  // SDL app origin for deep-linking a lab order into SDL's doctor view.
  let sdlWebBase: string | null = null
  const { data: sdlConfig } = await supabase
    .from('connector_configs')
    .select('enabled, credentials')
    .eq('organization_id', caseData.organization_id)
    .eq('connector_type', 'smile_design_lab')
    .maybeSingle()
  if (sdlConfig?.enabled) {
    const apiUrl = ((sdlConfig.credentials ?? {}) as Record<string, string>).api_url
    if (apiUrl) sdlWebBase = apiUrl.replace(/\/$/, '')
  }

  return NextResponse.json({ case: result, sdl_web_base: sdlWebBase })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const allowedFields = ['status', 'clinical_notes', 'assigned_doctor_id', 'priority', 'patient_name', 'patient_email', 'patient_phone']
  const updates: Record<string, unknown> = {}

  for (const field of allowedFields) {
    if (body[field] !== undefined) updates[field] = body[field]
  }

  // Timestamp tracking for status transitions
  if (body.status === 'completed') updates.completed_at = new Date().toISOString()

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  const { data: updated, error } = await supabase
    .from('clinical_cases')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ case: updated })
}
