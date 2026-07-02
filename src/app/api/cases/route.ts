import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { hasPermission } from '@/lib/auth/permissions'

/**
 * GET /api/cases — List cases for the org
 * POST /api/cases — Create a new case
 */

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single()
  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

  if (!hasPermission(profile.role, 'cases:read')) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')
  const assignedTo = searchParams.get('assigned_to')

  let query = supabase
    .from('clinical_cases')
    .select(`
      *,
      case_files (id, file_name, file_type, file_url, ai_analyzed_at),
      creator:user_profiles!clinical_cases_created_by_fkey (id, full_name, role, avatar_url),
      assigned_doctor:user_profiles!clinical_cases_assigned_doctor_id_fkey (id, full_name, role, avatar_url, specialty),
      treatment_closings!treatment_closings_clinical_case_id_fkey (
        id, current_step, steps_completed, contract_signed_at, contract_amount,
        financing_type, financing_funded_at, consent_signed_at,
        preop_instructions_sent_at, surgery_date, surgery_time,
        records_checklist, records_confirmed_at
      )
    `)
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })

  if (status) query = query.eq('status', status)
  if (assignedTo) query = query.eq('assigned_doctor_id', assignedTo)

  const { data: cases, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // The case↔closing link is 1:1 (unique partial index), but PostgREST embeds it
  // as an array — flatten to a single `closing` object for the client.
  const normalized = (cases || []).map((c) => {
    const { treatment_closings, ...rest } = c as typeof c & { treatment_closings?: unknown[] }
    return { ...rest, closing: Array.isArray(treatment_closings) ? treatment_closings[0] ?? null : treatment_closings ?? null }
  })

  return NextResponse.json({ cases: normalized })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single()
  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

  if (!hasPermission(profile.role, 'cases:create')) {
    return NextResponse.json({ error: 'Access denied: clinical role required' }, { status: 403 })
  }

  const body = await request.json()
  const { patient_name, patient_email, patient_phone, chief_complaint, clinical_notes, assigned_doctor_id, lead_id, priority } = body

  if (!patient_name || !chief_complaint) {
    return NextResponse.json({ error: 'Missing required: patient_name, chief_complaint' }, { status: 400 })
  }

  const { data: newCase, error } = await supabase
    .from('clinical_cases')
    .insert({
      organization_id: orgId,
      lead_id: lead_id || null,
      patient_name,
      patient_email: patient_email || null,
      patient_phone: patient_phone || null,
      case_number: '',
      chief_complaint,
      clinical_notes: clinical_notes || null,
      status: 'intake',
      priority: priority || 'normal',
      created_by: user.id,
      assigned_doctor_id: assigned_doctor_id || null,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ case: newCase }, { status: 201 })
}
