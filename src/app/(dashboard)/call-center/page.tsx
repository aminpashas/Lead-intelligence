import { createClient } from '@/lib/supabase/server'
import { CallCenterDashboard } from '@/components/voice/call-center-dashboard'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { decryptLeadPII } from '@/lib/encryption'
import { applyCallMetric, startOfTodayISO } from '@/lib/voice/call-metrics'

export default async function CallCenterPage() {
  const supabase = await createClient()

  // Effective org honors an agency_admin's entered client account.
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return null

  // Fetch recent voice calls
  // Pull the full lead (not just name/status): the Call Center's inline action
  // bar needs phone, email and the per-channel opt-out flags to gate Call/SMS/Email.
  const { data: recentCallRows } = await supabase
    .from('voice_calls')
    .select('*, lead:leads(*)')
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

  // Aggregate stats. Each card is a filter over voice_calls; applyCallMetric is
  // shared with the drill-down list endpoint so the count and the list agree.
  const todayISO = startOfTodayISO()

  const countFor = (metric: Parameters<typeof applyCallMetric>[1]) =>
    applyCallMetric(
      supabase
        .from('voice_calls')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId),
      metric,
      todayISO,
    )

  const [{ count: todayCalls }, { count: todayConnected }, { count: todayAppointments }, { count: activeCalls }] =
    await Promise.all([countFor('today'), countFor('connected'), countFor('appointments'), countFor('active')])

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
