import { createClient } from '@/lib/supabase/server'
import { CallCenterDashboard } from '@/components/voice/call-center-dashboard'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { decryptLeadPII } from '@/lib/encryption'

export default async function CallCenterPage() {
  const supabase = await createClient()

  // Effective org honors an agency_admin's entered client account.
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return null

  // Fetch recent voice calls
  const { data: recentCallRows } = await supabase
    .from('voice_calls')
    .select('*, lead:leads(id, first_name, last_name, phone, ai_qualification, status)')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .limit(50)

  // Lead PII is encrypted at rest — decrypt server-side before rendering.
  const recentCalls = (recentCallRows || []).map((call) => ({
    ...call,
    lead: call.lead ? decryptLeadPII(call.lead as Record<string, unknown>) : call.lead,
  }))

  // Fetch voice campaigns
  const { data: campaigns } = await supabase
    .from('voice_campaigns')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })

  // Fetch org voice settings
  const { data: org } = await supabase
    .from('organizations')
    .select('name, voice_enabled, voice_retell_agent_id, voice_max_outbound_per_hour, voice_recording_enabled')
    .eq('id', orgId)
    .single()

  // Aggregate stats
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayISO = today.toISOString()

  const { count: todayCalls } = await supabase
    .from('voice_calls')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .gte('created_at', todayISO)

  const { count: todayConnected } = await supabase
    .from('voice_calls')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .eq('status', 'completed')
    .gt('duration_seconds', 0)
    .gte('created_at', todayISO)

  const { count: todayAppointments } = await supabase
    .from('voice_calls')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .eq('outcome', 'appointment_booked')
    .gte('created_at', todayISO)

  const { count: activeCalls } = await supabase
    .from('voice_calls')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
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
