import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import { getOwnProfile } from '@/lib/auth/active-org'
import { isAdminRole } from '@/lib/auth/permissions'
import { LeadDetail } from '@/components/crm/lead-detail'
import { buildTimeline } from '@/lib/timeline/build-timeline'
import { pickConversationToAnalyze } from '@/lib/timeline/pick-conversation'
import { decryptLeadPII } from '@/lib/encryption'
import { isFlagEnabled } from '@/lib/org/flags'
import { resolvePracticeTimeZone } from '@/lib/time/practice-timezone'

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  // Fetch lead with relations
  const { data: leadRow } = await supabase
    .from('leads')
    .select(`
      *,
      pipeline_stage:pipeline_stages(*),
      source:lead_sources(*),
      assigned_user:user_profiles!leads_assigned_to_fkey(*)
    `)
    .eq('id', id)
    .single()

  if (!leadRow) notFound()

  // PII is encrypted at rest — decrypt server-side before rendering.
  const lead = decryptLeadPII(leadRow)

  // Fetch activities
  const { data: activities } = await supabase
    .from('lead_activities')
    .select('*')
    .eq('lead_id', id)
    .order('created_at', { ascending: false })
    .limit(50)

  // Fetch conversations
  const { data: conversations } = await supabase
    .from('conversations')
    .select('*')
    .eq('lead_id', id)
    .order('last_message_at', { ascending: false })

  // The most recently active conversation is the one the embedded chat opens on.
  const primaryConversation = conversations?.[0] ?? null

  // Everything the lead has said or done — texts AND emails across every
  // conversation, plus every finished call (even calls logged against the lead
  // with no conversation_id) — so the in-lead thread shows it all together, not
  // just the primary conversation's slice. Sending/AI still target
  // primaryConversation below; this is purely what the thread renders.
  const { data: threadMessages } = await supabase
    .from('messages')
    .select('*')
    .eq('lead_id', id)
    .order('created_at', { ascending: true })

  const { data: threadCalls } = await supabase
    .from('voice_calls')
    .select('*')
    .eq('lead_id', id)
    .not('ended_at', 'is', null)
    .order('created_at', { ascending: true })

  // Fetch messages (all channels) for the unified timeline
  const { data: messages } = await supabase
    .from('messages')
    .select('id, created_at, channel, direction, body, subject, status, ai_generated, sender_type, sender_name')
    .eq('lead_id', id)
    .order('created_at', { ascending: true })
    .limit(300)

  // Fetch logged voice calls for the unified timeline
  const { data: voiceCalls } = await supabase
    .from('voice_calls')
    .select('id, created_at, started_at, direction, outcome, duration_seconds, outcome_notes, transcript_summary, recording_url, status, call_mode, agent_type, staff_user_id')
    .eq('lead_id', id)
    .order('created_at', { ascending: true })
    .limit(300)

  const timeline = buildTimeline({
    messages: messages || [],
    calls: voiceCalls || [],
    activities: activities || [],
  })

  // Fetch the latest AI intelligence (already computed by /api/ai/analyze)
  const { data: patientProfile } = await supabase
    .from('patient_profiles')
    .select('*')
    .eq('lead_id', id)
    .maybeSingle()

  const { data: latestAnalysis } = await supabase
    .from('conversation_analyses')
    .select('*')
    .eq('lead_id', id)
    .order('analyzed_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const analyzableConversationId = pickConversationToAnalyze(conversations || [])

  // Fetch pipeline stages
  const { data: stages } = await supabase
    .from('pipeline_stages')
    .select('*')
    .eq('organization_id', lead.organization_id)
    .order('position')

  // Fetch team members for assignment
  const { data: teamMembers } = await supabase
    .from('user_profiles')
    .select('id, full_name, email, role')
    .eq('organization_id', lead.organization_id)
    .eq('is_active', true)

  // Account-level pre-qualification switch — drives whether the per-lead
  // "Send Pre-Qual" action shows in the action bar.
  const prequalEnabled = await isFlagEnabled(supabase, lead.organization_id, 'financing_prequal_enabled')

  // Practice no-show fee switch — drives whether the per-lead "Card link" action
  // (text/resend the card-on-file link) shows in the action bar.
  const { data: bookingSettingsRow } = await supabase
    .from('booking_settings')
    .select('no_show_fee_enabled')
    .eq('organization_id', lead.organization_id)
    .maybeSingle()
  const noShowFeeEnabled = bookingSettingsRow?.no_show_fee_enabled === true

  // Thread timestamps render in the practice timezone so SSR (UTC) and the
  // browser agree on day boundaries.
  const timeZone = await resolvePracticeTimeZone(supabase, lead.organization_id)

  // Admins get the per-call "Use for AI training" control on call cards.
  const { data: ownProfile } = await getOwnProfile(supabase, 'role')
  const canTrainAi = !!ownProfile && isAdminRole(ownProfile.role)

  return (
    <LeadDetail
      lead={lead}
      activities={activities || []}
      conversations={conversations || []}
      primaryConversation={primaryConversation}
      threadMessages={threadMessages || []}
      threadCalls={threadCalls || []}
      timeline={timeline}
      patientProfile={patientProfile}
      latestAnalysis={latestAnalysis}
      analyzableConversationId={analyzableConversationId}
      stages={stages || []}
      teamMembers={teamMembers || []}
      prequalEnabled={prequalEnabled}
      noShowFeeEnabled={noShowFeeEnabled}
      timeZone={timeZone}
      canTrainAi={canTrainAi}
    />
  )
}
