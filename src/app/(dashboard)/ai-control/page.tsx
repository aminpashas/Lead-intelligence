import { createClient } from '@/lib/supabase/server'
import { AIControlCenter } from '@/components/crm/ai-control-center'

export default async function AIControlPage() {
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .single()

  if (!profile) return null

  const orgId = profile.organization_id

  // Fetch autopilot settings
  const { data: org } = await supabase
    .from('organizations')
    .select(`
      autopilot_enabled,
      autopilot_paused,
      autopilot_confidence_threshold,
      autopilot_mode,
      autopilot_response_delay_min,
      autopilot_response_delay_max,
      autopilot_max_messages_per_hour,
      autopilot_active_hours_start,
      autopilot_active_hours_end,
      autopilot_stop_words,
      autopilot_speed_to_lead,
      autopilot_schedule
    `)
    .eq('id', orgId)
    .single()

  // Fetch active AI conversations
  const { data: aiConversations } = await supabase
    .from('conversations')
    .select(`
      id, channel, ai_enabled, ai_mode, active_agent,
      last_message_at, last_message_preview, message_count, sentiment,
      lead:leads(id, first_name, last_name, ai_qualification, status, ai_autopilot_override)
    `)
    .eq('organization_id', orgId)
    .eq('status', 'active')
    .order('last_message_at', { ascending: false })
    .limit(100)

  // Fetch recent AI activities
  const { data: recentActivities } = await supabase
    .from('lead_activities')
    .select(`
      id, activity_type, title, description, metadata, created_at,
      lead:leads(id, first_name, last_name)
    `)
    .eq('organization_id', orgId)
    .in('activity_type', [
      'ai_auto_response', 'ai_mode_changed', 'ai_escalated',
      'enriched', 'ai_scored', 'ai_speed_to_lead',
      'ai_draft_generated', 'financing_link_sent',
    ])
    .order('created_at', { ascending: false })
    .limit(20)

  // Fetch pending escalations count
  const { count: pendingEscalations } = await supabase
    .from('autopilot_escalations')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .eq('status', 'pending')

  return (
    <AIControlCenter
      settings={org || {}}
      conversations={aiConversations || []}
      recentActivities={recentActivities || []}
      pendingEscalations={pendingEscalations || 0}
      isAdmin={profile.role === 'admin' || profile.role === 'owner'}
    />
  )
}
