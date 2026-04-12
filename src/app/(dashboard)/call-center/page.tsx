import { createClient } from '@/lib/supabase/server'
import { CallCenterDashboard } from '@/components/voice/call-center-dashboard'

export default async function CallCenterPage() {
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) return null

  // Fetch recent voice calls
  const { data: recentCalls } = await supabase
    .from('voice_calls')
    .select('*, lead:leads(id, first_name, last_name, phone, ai_qualification, status)')
    .eq('organization_id', profile.organization_id)
    .order('created_at', { ascending: false })
    .limit(50)

  // Fetch voice campaigns
  const { data: campaigns } = await supabase
    .from('voice_campaigns')
    .select('*')
    .eq('organization_id', profile.organization_id)
    .order('created_at', { ascending: false })

  // Fetch org voice settings
  const { data: org } = await supabase
    .from('organizations')
    .select('name, voice_enabled, voice_retell_agent_id, voice_max_outbound_per_hour, voice_recording_enabled')
    .eq('id', profile.organization_id)
    .single()

  // Aggregate stats
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayISO = today.toISOString()

  const { count: todayCalls } = await supabase
    .from('voice_calls')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', profile.organization_id)
    .gte('created_at', todayISO)

  const { count: todayConnected } = await supabase
    .from('voice_calls')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', profile.organization_id)
    .eq('status', 'completed')
    .gt('duration_seconds', 0)
    .gte('created_at', todayISO)

  const { count: todayAppointments } = await supabase
    .from('voice_calls')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', profile.organization_id)
    .eq('outcome', 'appointment_booked')
    .gte('created_at', todayISO)

  const { count: activeCalls } = await supabase
    .from('voice_calls')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', profile.organization_id)
    .in('status', ['initiated', 'ringing', 'in_progress'])

  return (
    <CallCenterDashboard
      recentCalls={recentCalls || []}
      campaigns={campaigns || []}
      orgSettings={org || { name: '', voice_enabled: false }}
      stats={{
        todayCalls: todayCalls || 0,
        todayConnected: todayConnected || 0,
        todayAppointments: todayAppointments || 0,
        activeCalls: activeCalls || 0,
      }}
    />
  )
}
