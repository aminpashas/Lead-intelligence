import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { updateLeadSchema } from '@/lib/validators/lead'

// GET /api/leads/[id] - Get lead details
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { data: lead, error } = await supabase
    .from('leads')
    .select(`
      *,
      pipeline_stage:pipeline_stages(*),
      source:lead_sources(*),
      assigned_user:user_profiles!leads_assigned_to_fkey(*)
    `)
    .eq('id', id)
    .single()

  if (error || !lead) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  }

  // Fetch recent activities
  const { data: activities } = await supabase
    .from('lead_activities')
    .select('*')
    .eq('lead_id', id)
    .order('created_at', { ascending: false })
    .limit(50)

  // Fetch conversations
  const { data: conversations } = await supabase
    .from('conversations')
    .select('*, messages:messages(count)')
    .eq('lead_id', id)
    .order('last_message_at', { ascending: false })

  // Fetch appointments
  const { data: appointments } = await supabase
    .from('appointments')
    .select('*')
    .eq('lead_id', id)
    .order('scheduled_at', { ascending: false })

  return NextResponse.json({
    lead,
    activities: activities || [],
    conversations: conversations || [],
    appointments: appointments || [],
  })
}

// PATCH /api/leads/[id] - Update a lead
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const body = await request.json()
  const parsed = updateLeadSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  // Get current lead state for activity logging
  const { data: currentLead } = await supabase
    .from('leads')
    .select('status, stage_id, ai_score, assigned_to, organization_id')
    .eq('id', id)
    .single()

  if (!currentLead) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  }

  const { data: lead, error } = await supabase
    .from('leads')
    .update(parsed.data)
    .eq('id', id)
    .select('*, pipeline_stage:pipeline_stages(*)')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Log status changes
  if (parsed.data.status && parsed.data.status !== currentLead.status) {
    await supabase.from('lead_activities').insert({
      organization_id: currentLead.organization_id,
      lead_id: id,
      activity_type: 'status_changed',
      title: `Status changed to ${parsed.data.status}`,
      metadata: { from: currentLead.status, to: parsed.data.status },
    })
  }

  // Log stage changes
  if (parsed.data.stage_id && parsed.data.stage_id !== currentLead.stage_id) {
    await supabase.from('lead_activities').insert({
      organization_id: currentLead.organization_id,
      lead_id: id,
      activity_type: 'stage_changed',
      title: 'Pipeline stage changed',
      metadata: { from_stage: currentLead.stage_id, to_stage: parsed.data.stage_id },
    })
  }

  return NextResponse.json({ lead })
}

// DELETE /api/leads/[id] - Delete a lead
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { error } = await supabase.from('leads').delete().eq('id', id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
