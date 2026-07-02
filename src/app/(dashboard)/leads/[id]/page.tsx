import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import { LeadDetail } from '@/components/crm/lead-detail'
import { buildTimeline } from '@/lib/timeline/build-timeline'
import { pickConversationToAnalyze } from '@/lib/timeline/pick-conversation'
import { decryptLeadPII } from '@/lib/encryption'

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
    .select('id, created_at, started_at, direction, outcome, duration_seconds, outcome_notes, transcript_summary, recording_url, status')
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

  return (
    <LeadDetail
      lead={lead}
      activities={activities || []}
      conversations={conversations || []}
      timeline={timeline}
      patientProfile={patientProfile}
      latestAnalysis={latestAnalysis}
      analyzableConversationId={analyzableConversationId}
      stages={stages || []}
      teamMembers={teamMembers || []}
    />
  )
}
