import { createClient } from '@/lib/supabase/server'
import { DashboardHome } from '@/components/crm/dashboard-home'

export default async function DashboardPage() {
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, full_name')
    .single()

  if (!profile) return null

  const orgId = profile.organization_id
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString()
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()

  // Run all queries in parallel
  const [
    hotLeadsResult,
    todayApptsResult,
    recentLeadsResult,
    unreadConvosResult,
    activeCampaignsResult,
    recentActivitiesResult,
    kpiResult,
    weekLeadsResult,
  ] = await Promise.all([
    // Hot leads needing attention (no response in 24h+)
    supabase
      .from('leads')
      .select('id, first_name, last_name, phone, email, ai_score, ai_qualification, status, last_contacted_at, last_responded_at, created_at')
      .eq('organization_id', orgId)
      .eq('ai_qualification', 'hot')
      .not('status', 'in', '("disqualified","lost","completed","contract_signed")')
      .order('ai_score', { ascending: false })
      .limit(10),

    // Today's appointments
    supabase
      .from('appointments')
      .select('*, lead:leads(id, first_name, last_name, phone)')
      .eq('organization_id', orgId)
      .gte('scheduled_at', todayStart)
      .lt('scheduled_at', todayEnd)
      .in('status', ['scheduled', 'confirmed'])
      .order('scheduled_at', { ascending: true }),

    // Newest leads (last 48h)
    supabase
      .from('leads')
      .select('id, first_name, last_name, ai_score, ai_qualification, source_type, status, created_at')
      .eq('organization_id', orgId)
      .gte('created_at', new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: false })
      .limit(8),

    // Unread conversations
    supabase
      .from('conversations')
      .select('id, channel, unread_count, last_message_preview, last_message_at, lead:leads(id, first_name, last_name)')
      .eq('organization_id', orgId)
      .gt('unread_count', 0)
      .order('last_message_at', { ascending: false })
      .limit(5),

    // Active campaigns
    supabase
      .from('campaigns')
      .select('id, name, status, channel, total_enrolled, total_converted')
      .eq('organization_id', orgId)
      .eq('status', 'active'),

    // Recent activities
    supabase
      .from('lead_activities')
      .select('id, activity_type, title, description, created_at, lead:leads(id, first_name, last_name)')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(12),

    // KPIs
    supabase
      .from('leads')
      .select('id, status, ai_qualification, treatment_value, created_at', { count: 'exact' })
      .eq('organization_id', orgId),

    // Leads this week (for trend)
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('created_at', sevenDaysAgo),
  ])

  const allLeads = kpiResult.data || []
  const totalLeads = allLeads.length
  const hotCount = allLeads.filter((l) => l.ai_qualification === 'hot').length
  const convertedCount = allLeads.filter((l) =>
    ['contract_signed', 'scheduled', 'in_treatment', 'completed'].includes(l.status)
  ).length
  const pipelineValue = allLeads.reduce((s, l) => s + (l.treatment_value || 0), 0)
  const weekLeads = weekLeadsResult.count || 0

  return (
    <DashboardHome
      userName={profile.full_name?.split(' ')[0] || 'there'}
      hotLeads={hotLeadsResult.data || []}
      todayAppointments={todayApptsResult.data || []}
      recentLeads={recentLeadsResult.data || []}
      unreadConversations={unreadConvosResult.data || []}
      activeCampaigns={activeCampaignsResult.data || []}
      recentActivities={recentActivitiesResult.data || []}
      kpis={{
        totalLeads,
        hotLeads: hotCount,
        converted: convertedCount,
        pipelineValue,
        weekLeads,
        todayAppointments: todayApptsResult.data?.length || 0,
        unreadMessages: (unreadConvosResult.data || []).reduce((s, c) => s + c.unread_count, 0),
      }}
    />
  )
}
