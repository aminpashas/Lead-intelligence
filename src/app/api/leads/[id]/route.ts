import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { updateLeadSchema } from '@/lib/validators/lead'
import { decryptLeadPII, encryptLeadPII } from '@/lib/encryption'
import { auditPHIRead, auditPHIWrite, auditPHIDeletion } from '@/lib/hipaa-audit'
import { applyStageMove } from '@/lib/pipeline/stage-move'
import { formatToE164 } from '@/lib/leads/phone'
import { findPhoneConflicts, describeConflict } from '@/lib/leads/contact-conflict'

// GET /api/leads/[id] - Get lead details
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Auth + org scoping: verify user belongs to an org
  const { data: profile } = await getOwnProfile(supabase, 'id, organization_id')

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: lead, error } = await supabase
    .from('leads')
    .select(`
      *,
      pipeline_stage:pipeline_stages(*),
      source:lead_sources(*),
      assigned_user:user_profiles!leads_assigned_to_fkey(*)
    `)
    .eq('id', id)
    .eq('organization_id', orgId) // Defense-in-depth: explicit org scoping
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

  const response: Record<string, unknown> = {
    lead: decryptLeadPII(lead as any),
    activities: activities || [],
    conversations: conversations || [],
    appointments: appointments || [],
  }

  // ?include=patient_summary — the AI intelligence bundle PatientSummaryCard
  // renders (profile + AI message count + active agent + last handoff).
  if (request.nextUrl.searchParams.get('include') === 'patient_summary') {
    const [{ data: patientProfile }, { count: aiMessageCount }, { data: lastHandoff }] =
      await Promise.all([
        supabase
          .from('patient_profiles')
          .select('*')
          .eq('lead_id', id)
          .maybeSingle(),
        supabase
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('lead_id', id)
          .eq('ai_generated', true),
        supabase
          .from('agent_handoffs')
          .select('from_agent, to_agent, trigger_reason')
          .eq('lead_id', id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ])

    response.patient_profile = patientProfile
    response.conversation_count = (conversations || []).length
    response.ai_message_count = aiMessageCount || 0
    response.active_agent = (conversations || [])[0]?.active_agent || null
    response.last_handoff = lastHandoff
  }

  return NextResponse.json(response)
}

// PATCH /api/leads/[id] - Update a lead
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const parsed = updateLeadSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  // Auth + org scoping
  const { data: profile } = await getOwnProfile(supabase, 'id, organization_id')

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get current lead state for activity logging — scoped to org
  const { data: currentLead } = await supabase
    .from('leads')
    .select('status, stage_id, ai_score, assigned_to, organization_id')
    .eq('id', id)
    .eq('organization_id', orgId) // Defense-in-depth: explicit org scoping
    .single()

  if (!currentLead) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  }

  // Staff-entered contact edits arrive as a plain `phone`/`email`. Two things
  // have to happen before the write that the Zod validator cannot do:
  //
  //  1. Derive `phone_formatted` (E.164). Every send path hard-rejects on a null
  //     phone_formatted (see /api/sms/send), so a phone written without it shows
  //     in the UI but can never be texted — the number looks present and the
  //     lead is silently unreachable.
  //  2. encryptLeadPII derives phone_hash from phone_formatted when present and
  //     falls back to raw `phone` otherwise. Skipping (1) would stamp a hash over
  //     "(415) 555-1212" while every other row hashes "+14155551212", quietly
  //     breaking dedup lookups (lib/leads/dedupe.ts) for this lead alone.
  //
  // Clearing a field must also clear its search hash — encryptLeadPII only
  // *sets* hashes for truthy values, so a stale hash would otherwise survive and
  // keep matching a contact the lead no longer has.
  const patch: Record<string, unknown> = { ...parsed.data }

  if (typeof patch.phone === 'string') {
    const raw = patch.phone.trim()
    if (!raw) {
      patch.phone = null
      patch.phone_formatted = null
      patch.phone_hash = null
    } else {
      const e164 = formatToE164(raw)
      if (!e164) {
        return NextResponse.json(
          { error: 'That does not look like a valid phone number. Enter a 10-digit US number.' },
          { status: 400 },
        )
      }
      patch.phone = raw
      patch.phone_formatted = e164

      // No unique index guards phone (households share lines), so a duplicate
      // writes cleanly and only bites later, when an inbound message resolves
      // to the wrong lead. Surface it once and let the caller confirm.
      if (body?.confirm_duplicate_phone !== true) {
        const conflicts = await findPhoneConflicts(supabase, orgId, e164, id)
        if (conflicts.length > 0) {
          return NextResponse.json(
            {
              error: 'duplicate_phone',
              message: `${describeConflict(conflicts[0])} already has this number. Inbound texts and calls may route to either lead.`,
              conflicts: conflicts.map((c) => ({ id: c.id, name: describeConflict(c) })),
            },
            { status: 409 },
          )
        }
      }
    }
  }

  if (typeof patch.email === 'string') {
    const raw = patch.email.trim().toLowerCase()
    if (!raw) {
      patch.email = null
      patch.email_hash = null
    } else {
      patch.email = raw
    }
  }

  const updateData = encryptLeadPII(patch)

  const { data: lead, error } = await supabase
    .from('leads')
    .update(updateData)
    .eq('id', id)
    .select('*, pipeline_stage:pipeline_stages(*)')
    .single()

  if (error) {
    // Email is uniquely indexed per org (phone deliberately is not — households
    // share a line). Surface the collision as a real message instead of a bare
    // 500, mirroring how ingest.ts:242 treats the same violation.
    if (error.code === '23505') {
      return NextResponse.json(
        { error: 'Another lead in this practice already uses that email address.' },
        { status: 409 },
      )
    }
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

  // Log stage changes and trigger funnel + campaign automations via the shared
  // stage-move engine (same path the bulk recommendation apply uses). The lead
  // row was already updated above (updateData includes stage_id), so pass the
  // TRUE prior stage via knownFromStageId — re-reading the row would report the
  // new stage as "from". Automation failures are recorded per lead inside the
  // helper (automation_error activities) and never fail the PATCH.
  if (parsed.data.stage_id && parsed.data.stage_id !== currentLead.stage_id) {
    await applyStageMove(supabase, {
      organizationId: currentLead.organization_id,
      leadIds: [id],
      toStageId: parsed.data.stage_id,
      actor: { type: 'user', userId: profile.id, source: 'lead_update' },
      knownFromStageId: currentLead.stage_id ?? null,
      activityTitle: 'Pipeline stage changed',
    })
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
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Auth + org scoping
  const { data: profile } = await getOwnProfile(supabase, 'id, organization_id')

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get org before deletion for audit — scoped to org
  const { data: deleteLead } = await supabase
    .from('leads')
    .select('organization_id')
    .eq('id', id)
    .eq('organization_id', orgId) // Defense-in-depth: explicit org scoping
    .single()

  if (!deleteLead) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  }

  const { error } = await supabase.from('leads').delete().eq('id', id).eq('organization_id', orgId)

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
