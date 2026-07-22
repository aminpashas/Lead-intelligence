import { createClient } from '@/lib/supabase/server'
import { getOwnProfile } from '@/lib/auth/active-org'
import { isAdminRole } from '@/lib/auth/permissions'
import { ConversationView } from '@/components/crm/conversation-view'
import { notFound } from 'next/navigation'
import { decryptLeadPII } from '@/lib/encryption'
import { buildTimeline } from '@/lib/timeline/build-timeline'
import { fetchLeadNotes } from '@/lib/timeline/lead-notes'
import { isFlagEnabled } from '@/lib/org/flags'
import { resolvePracticeTimeZone } from '@/lib/time/practice-timezone'
import type { ConversationAnalysis, PatientProfile, PipelineStage } from '@/types/database'

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const { data: conversation } = await supabase
    .from('conversations')
    .select('*, lead:leads(id, first_name, last_name, phone, email, ai_qualification, ai_score, ai_summary, engagement_score, status, stage_id, source_type, dental_condition, utm_source, utm_campaign, campaign_attribution, tags, custom_fields, pipeline_stage:pipeline_stages(id, name, color, position))')
    .eq('id', id)
    .single()

  if (!conversation) return notFound()

  const leadId = (conversation.lead as { id?: string } | null)?.id ?? conversation.lead_id

  /**
   * History is scoped to the PATIENT, not this conversation row.
   *
   * `conversations` are per-channel here (one row for sms, another for email,
   * another for voice — 382/48/6 in prod), so keying the thread on
   * `conversation_id` showed one channel's slice: opening a call-review task
   * landed on the voice-only row and none of the patient's texts were visible.
   * `/leads/[id]` has always joined on `lead_id` and shown everything merged;
   * this page now matches it, so the same patient reads the same either way.
   *
   * Sending still targets `conversation` (the row in the URL) — this widening is
   * purely what gets RENDERED. Orphan conversations with no lead fall back to
   * the old conversation-scoped query so they don't render empty.
   */
  const messagesQuery = supabase.from('messages').select('*').order('created_at', { ascending: true })
  const { data: messages } = leadId
    ? await messagesQuery.eq('lead_id', leadId)
    : await messagesQuery.eq('conversation_id', id)

  // Completed calls only — rendered as transcript cards in the timeline. Active
  // calls (ended_at null) are handled live by the client panel, so pulling only
  // finished ones here avoids double-rendering.
  const callsQuery = supabase
    .from('voice_calls')
    .select('*')
    .not('ended_at', 'is', null)
    .order('created_at', { ascending: true })
  const { data: calls } = leadId
    ? await callsQuery.eq('lead_id', leadId)
    : await callsQuery.eq('conversation_id', id)

  // Notes + stage changes for this lead enrich the condensed Timeline view.
  const { data: activities } = await supabase
    .from('lead_activities')
    .select('id, created_at, activity_type, title, description')
    .eq('lead_id', leadId)
    .in('activity_type', ['note_added', 'stage_changed'])
    .order('created_at', { ascending: true })

  // Mark as read
  await supabase
    .from('conversations')
    .update({ unread_count: 0 })
    .eq('id', id)

  const timeline = buildTimeline({
    messages: messages || [],
    calls: calls || [],
    activities: activities || [],
  })

  // Persisted intelligence — seeds the thread's side panel so insights + the
  // lead summary render instantly without re-running (and re-paying for) the AI.
  const { data: savedAnalysis } = await supabase
    .from('conversation_analyses')
    .select('*')
    .eq('conversation_id', id)
    .order('analyzed_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: patientProfile } = leadId
    ? await supabase
        .from('patient_profiles')
        .select('*')
        .eq('lead_id', leadId)
        .maybeSingle()
    : { data: null }

  // Account-level pre-qualification switch — gates the "Send Pre-Qual" action.
  const prequalEnabled = conversation.organization_id
    ? await isFlagEnabled(supabase, conversation.organization_id as string, 'financing_prequal_enabled')
    : false

  // Practice no-show fee switch — gates the "Card link" action.
  const { data: convBookingSettings } = conversation.organization_id
    ? await supabase
        .from('booking_settings')
        .select('no_show_fee_enabled')
        .eq('organization_id', conversation.organization_id as string)
        .maybeSingle()
    : { data: null }
  const noShowFeeEnabled = convBookingSettings?.no_show_fee_enabled === true

  // Render all thread timestamps in the practice timezone so SSR (UTC) agrees
  // with the browser on day boundaries.
  const timeZone = await resolvePracticeTimeZone(supabase, conversation.organization_id as string | null)

  // Admins get the per-call "Use for AI training" control on call cards. `id` is
  // also needed so the Notes panel knows which notes the viewer may edit.
  const { data: ownProfile } = await getOwnProfile(supabase, 'id, role')
  const canTrainAi = !!ownProfile && isAdminRole(ownProfile.role)

  // Manual team notes for the lead behind this conversation.
  const notes = leadId ? await fetchLeadNotes(supabase, leadId) : []

  // Pipeline stages — lets staff move the lead's stage from inside the thread,
  // right after the call or text that earned the move.
  const { data: stages } = conversation.organization_id
    ? await supabase
        .from('pipeline_stages')
        .select('*')
        .eq('organization_id', conversation.organization_id as string)
        .order('position')
    : { data: null }

  return (
    <ConversationView
      lead={decryptLeadPII(conversation.lead as Record<string, unknown>) as any}
      stages={(stages as PipelineStage[] | null) ?? []}
      conversation={conversation}
      messages={messages || []}
      calls={calls || []}
      timeline={timeline}
      prequalEnabled={prequalEnabled}
      noShowFeeEnabled={noShowFeeEnabled}
      savedAnalysis={(savedAnalysis as ConversationAnalysis | null) ?? null}
      patientProfile={(patientProfile as PatientProfile | null) ?? null}
      timeZone={timeZone}
      embedded
      canTrainAi={canTrainAi}
      notes={notes}
      currentUserId={ownProfile?.id ?? null}
    />
  )
}
