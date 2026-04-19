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
      assigned_doctor:user_profiles!clinical_cases_assigned_doctor_id_fkey (id, full_name, role, avatar_url, specialty)
    `)
    .eq('id', id)
    .single()

  if (error || !caseData) {
    return NextResponse.json({ error: 'Case not found' }, { status: 404 })
  }

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
  }
  delete result.case_files
  delete result.case_diagnosis
  delete result.case_treatment_plans

  return NextResponse.json({ case: result })
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
