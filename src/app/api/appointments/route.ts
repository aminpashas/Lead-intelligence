import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'

const createAppointmentSchema = z.object({
  lead_id: z.string().uuid(),
  type: z.enum(['consultation', 'follow_up', 'treatment', 'scan', 'other']),
  scheduled_at: z.string(), // ISO datetime
  duration_minutes: z.number().min(15).max(480).optional().default(60),
  location: z.string().optional(),
  notes: z.string().optional(),
  assigned_to: z.string().uuid().optional(),
})

// GET /api/appointments
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { searchParams } = new URL(request.url)

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let query = supabase
    .from('appointments')
    .select('*, lead:leads(id, first_name, last_name, phone, email)')
    .eq('organization_id', profile.organization_id)
    .order('scheduled_at', { ascending: true })

  const status = searchParams.get('status')
  if (status) query = query.eq('status', status)

  const from = searchParams.get('from')
  if (from) query = query.gte('scheduled_at', from)

  const to = searchParams.get('to')
  if (to) query = query.lte('scheduled_at', to)

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ appointments: data })
}

// POST /api/appointments
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const body = await request.json()
  const parsed = createAppointmentSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Defend against BOLA - assert lead belongs to this organization
  const { data: verifiedLead, error: leadError } = await supabase
    .from('leads')
    .select('id')
    .eq('id', parsed.data.lead_id)
    .eq('organization_id', profile.organization_id)
    .single()

  if (leadError || !verifiedLead) {
    return NextResponse.json({ error: 'Lead not found or unauthorized' }, { status: 404 })
  }

  const { data: appointment, error } = await supabase
    .from('appointments')
    .insert({
      ...parsed.data,
      organization_id: profile.organization_id,
      assigned_to: parsed.data.assigned_to || profile.id,
    })
    .select('*, lead:leads(id, first_name, last_name)')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Update lead status
  await supabase
    .from('leads')
    .update({
      status: 'consultation_scheduled',
      consultation_date: parsed.data.scheduled_at,
      consultation_type: parsed.data.type === 'consultation' ? 'in_person' : undefined,
    })
    .eq('id', parsed.data.lead_id)

  // Log activity
  await supabase.from('lead_activities').insert({
    organization_id: profile.organization_id,
    lead_id: parsed.data.lead_id,
    user_id: profile.id,
    activity_type: 'appointment_scheduled',
    title: `${parsed.data.type} scheduled for ${new Date(parsed.data.scheduled_at).toLocaleDateString()}`,
    metadata: { appointment_id: appointment.id, type: parsed.data.type },
  })

  return NextResponse.json({ appointment }, { status: 201 })
}
