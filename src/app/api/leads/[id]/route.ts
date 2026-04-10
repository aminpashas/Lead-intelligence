import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { updateLeadSchema } from '@/lib/validators/lead'
import { executeStageTransition } from '@/lib/funnel/executor'
import { decryptLeadPII, encryptLeadPII } from '@/lib/encryption'
import { auditPHIRead, auditPHIWrite, auditPHIDeletion } from '@/lib/hipaa-audit'
import { onStageChange } from '@/lib/campaigns/stage-automation'

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

  // HIPAA audit: log PHI access
  auditPHIRead(
    { supabase, organizationId: lead.organization_id },
    'lead',
    id,
    `Accessed lead detail record`,
    ['name', 'phone', 'email', 'medical_record', 'insurance_id', 'dob'],
  )

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
    lead: decryptLeadPII(lead as any),
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

  const updateData = encryptLeadPII(parsed.data as Record<string, unknown>)

  const { data: lead, error } = await supabase
    .from('leads')
    .update(updateData)
    .eq('id', id)
    .select('*, pipeline_stage:pipeline_stages(*)')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // HIPAA audit: log PHI update
  const updatedFields = Object.keys(parsed.data)
  const piiUpdated = updatedFields.some(f => ['email', 'phone', 'date_of_birth', 'insurance_provider', 'insurance_details'].includes(f))
  if (piiUpdated) {
    auditPHIWrite(
      { supabase, organizationId: currentLead.organization_id },
      'lead',
      id,
      `Updated lead PII fields: ${updatedFields.filter(f => ['email', 'phone', 'date_of_birth', 'insurance_provider'].includes(f)).join(', ')}`,
    )
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

    // Exit all campaigns when lead is lost or disqualified
    if (parsed.data.status === 'lost' || parsed.data.status === 'disqualified') {
      const { exitAllCampaigns } = await import('@/lib/campaigns/enrollments')
      exitAllCampaigns(supabase, id, `Lead status changed to ${parsed.data.status}`)
        .catch(async (err) => {
          console.error('Campaign exit error:', err)
          try {
            await supabase.from('lead_activities').insert({
              organization_id: currentLead.organization_id,
              lead_id: id,
              activity_type: 'automation_error',
              title: 'Campaign exit failed',
              metadata: { error: err instanceof Error ? err.message : 'unknown', trigger: 'status_change' },
            })
          } catch { /* best effort */ }
        })
    }
  }

  // Log stage changes and trigger funnel automations
  if (parsed.data.stage_id && parsed.data.stage_id !== currentLead.stage_id) {
    // Get stage slugs for automation matching
    const [{ data: fromStage }, { data: toStage }] = await Promise.all([
      currentLead.stage_id
        ? supabase.from('pipeline_stages').select('slug').eq('id', currentLead.stage_id).single()
        : Promise.resolve({ data: null }),
      supabase.from('pipeline_stages').select('slug').eq('id', parsed.data.stage_id).single(),
    ])

    await supabase.from('lead_activities').insert({
      organization_id: currentLead.organization_id,
      lead_id: id,
      activity_type: 'stage_changed',
      title: 'Pipeline stage changed',
      metadata: { from_stage: currentLead.stage_id, to_stage: parsed.data.stage_id },
    })

    // Execute funnel automations for this transition (non-blocking)
    if (toStage?.slug) {
      executeStageTransition(supabase, {
        organizationId: currentLead.organization_id,
        leadId: id,
        lead: lead as Record<string, unknown>,
        fromStageSlug: fromStage?.slug || null,
        toStageSlug: toStage.slug,
      }).catch(async (err) => {
        console.error('Automation execution error:', err)
        try {
          await supabase.from('lead_activities').insert({
            organization_id: currentLead.organization_id, lead_id: id,
            activity_type: 'automation_error', title: 'Funnel automation failed',
            metadata: { error: err instanceof Error ? err.message : 'unknown', trigger: 'stage_transition' },
          })
        } catch { /* best effort */ }
      })

      // Campaign stage automation: trigger campaigns, exit old campaigns (non-blocking)
      onStageChange(
        supabase,
        id,
        fromStage?.slug || 'unknown',
        toStage.slug,
        currentLead.organization_id
      ).catch(async (err) => {
        console.error('Campaign stage automation error:', err)
        try {
          await supabase.from('lead_activities').insert({
            organization_id: currentLead.organization_id, lead_id: id,
            activity_type: 'automation_error', title: 'Campaign stage automation failed',
            metadata: { error: err instanceof Error ? err.message : 'unknown', trigger: 'stage_change' },
          })
        } catch { /* best effort */ }
      })
    }
  }

  return NextResponse.json({ lead: decryptLeadPII(lead as any) })
}

// DELETE /api/leads/[id] - Delete a lead
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  // Get org before deletion for audit
  const { data: deleteLead } = await supabase
    .from('leads')
    .select('organization_id')
    .eq('id', id)
    .single()

  const { error } = await supabase.from('leads').delete().eq('id', id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (deleteLead) {
    auditPHIDeletion(
      { supabase, organizationId: deleteLead.organization_id },
      'lead',
      id,
      'Lead record and associated PHI permanently deleted',
    )
  }

  return NextResponse.json({ success: true })
}
