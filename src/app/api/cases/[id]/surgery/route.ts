import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { hasPermission } from '@/lib/auth/permissions'
import { advanceStepByCase, getTreatmentClosingByCase, createTreatmentClosing } from '@/lib/treatment/treatment-closing'
import { syncAppointmentToEhr } from '@/lib/booking/ehr-sync'

/**
 * POST /api/cases/[id]/surgery — Book the surgery for a closed case.
 *
 * Creates a `type='surgery'` appointment (when the case has a lead), advances
 * the treatment closing to `surgery_scheduled`, and fans out to CareStack +
 * Dion Clinical through the existing EHR sync seam (fire-and-forget).
 */

const bookSchema = z.object({
  scheduled_at: z.string().datetime({ offset: true }),
  duration_minutes: z.number().int().min(30).max(720).default(120),
  location: z.string().max(200).optional(),
  surgery_type: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single()
  if (!profile || !hasPermission(profile.role, 'cases:create')) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const { data: caseRow } = await supabase
    .from('clinical_cases')
    .select('id, organization_id, lead_id, status, patient_name')
    .eq('id', caseId)
    .eq('organization_id', orgId)
    .single()
  if (!caseRow) return NextResponse.json({ error: 'Case not found' }, { status: 404 })

  const parsed = bookSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })
  }
  const body = parsed.data

  // Ensure the closing exists (surgery can be booked even if earlier steps were
  // handled on paper — the stepper will show what's still outstanding).
  let closing = await getTreatmentClosingByCase(supabase, caseId)
  if (!closing) {
    closing = await createTreatmentClosing(supabase, {
      organizationId: orgId,
      leadId: caseRow.lead_id,
      clinicalCaseId: caseId,
    })
  }

  // Create the surgery appointment when the case is tied to a lead — the
  // appointments table (reminders, no-show machinery, EHR sync) is lead-keyed.
  let appointment: { id: string } | null = null
  if (caseRow.lead_id) {
    const { data: appt, error: apptError } = await supabase
      .from('appointments')
      .insert({
        organization_id: orgId,
        lead_id: caseRow.lead_id,
        type: 'surgery',
        status: 'scheduled',
        scheduled_at: body.scheduled_at,
        duration_minutes: body.duration_minutes,
        location: body.location || null,
        notes: body.notes || null,
        metadata: { case_id: caseId, surgery_type: body.surgery_type || null },
      })
      .select('id')
      .single()
    if (apptError) {
      return NextResponse.json({ error: apptError.message }, { status: 500 })
    }
    appointment = appt
  }

  // Advance the closing step (also flips the case to surgery_scheduled)
  const scheduled = new Date(body.scheduled_at)
  const result = await advanceStepByCase(supabase, caseId, 'surgery_scheduled', {
    surgery_date: scheduled.toISOString().slice(0, 10),
    surgery_time: scheduled.toISOString().slice(11, 16),
    surgery_type: body.surgery_type,
    estimated_duration_hours: Math.round((body.duration_minutes / 60) * 10) / 10,
    notes: body.notes,
  })
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 422 })
  }

  // Fan out to CareStack + Dion Clinical + Slack. Fire-and-forget: the booking
  // stands even if a downstream leg hiccups (cron re-drives failed legs).
  if (appointment) {
    void syncAppointmentToEhr(supabase, appointment.id, { action: 'book' })
  }

  return NextResponse.json({
    appointment_id: appointment?.id ?? null,
    closing: result.closing,
  }, { status: 201 })
}
