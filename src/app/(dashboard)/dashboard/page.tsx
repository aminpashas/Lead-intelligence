import { createClient } from '@/lib/supabase/server'
import { DashboardHome } from '@/components/crm/dashboard-home'
import { OrgGoalsCard } from '@/components/crm/org-goals-card'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { decryptLeadPII, decryptLeadsPII } from '@/lib/encryption'
import { PAID_AD_CHANNEL_OR_FILTER } from '@/lib/attribution'

export default async function DashboardPage() {
  const supabase = await createClient()

  // The user's display name comes from their own profile…
  const { data: profile } = await getOwnProfile(supabase, 'full_name')

  // …but the data is scoped to the effective org, which honors an agency_admin's
  // entered client account (see resolveActiveOrg).
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return null
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString()
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString()
  const sevenDaysAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()

  // Run all queries in parallel
  const [
    hotLeadsResult,
    todayApptsResult,
    recentLeadsResult,
    unreadConvosResult,
    activeCampaignsResult,
    recentActivitiesResult,
    totalLeadsResult,
    weekLeadsResult,
    prevWeekLeadsResult,
    awaitingContactResult,
    engagedResult,
    upcomingApptsResult,
    unreadThreadsResult,
    pipelineResult,
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

    // Newest leads (last 48h) — only genuine Meta/Google ad leads count as
    // "new leads"; imported nurturing-DB / organic / direct rows are excluded.
    supabase
      .from('leads')
      .select('id, first_name, last_name, ai_score, ai_qualification, source_type, status, created_at')
      .eq('organization_id', orgId)
      .gte('created_at', new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString())
      .or(PAID_AD_CHANNEL_OR_FILTER)
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

    // KPIs — all head-only counts aggregated by Postgres. Fetching rows and
    // counting in JS silently truncates at PostgREST's 1000-row cap, which is
    // how "Total Leads" once froze at exactly 1000.
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId),

    // New ad leads this week — counts only DGS-attributed Meta / Google paid
    // campaign leads, not imported nurturing-DB / organic / direct.
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('created_at', sevenDaysAgo)
      .or(PAID_AD_CHANNEL_OR_FILTER),

    // Same count for the week before, so the card can show a real trend.
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('created_at', fourteenDaysAgo)
      .lt('created_at', sevenDaysAgo)
      .or(PAID_AD_CHANNEL_OR_FILTER),

    // Speed-to-lead gap: this week's ad leads nobody has reached out to yet.
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('created_at', sevenDaysAgo)
      .is('last_contacted_at', null)
      .or(PAID_AD_CHANNEL_OR_FILTER),

    // Leads that replied to us in the last 7 days (any channel).
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('last_responded_at', sevenDaysAgo),

    // Appointments on the books for the coming week (today included).
    supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('scheduled_at', todayStart)
      .lt('scheduled_at', sevenDaysAhead)
      .in('status', ['scheduled', 'confirmed']),

    // Conversation threads with unread messages (the list above only fetches 5).
    supabase
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gt('unread_count', 0),

    // Pipeline value — only rows that actually carry a value, summed here.
    supabase
      .from('leads')
      .select('treatment_value')
      .eq('organization_id', orgId)
      .gt('treatment_value', 0),
  ])

  // PII is encrypted at rest — decrypt server-side before rendering.
  const hotLeads = decryptLeadsPII(hotLeadsResult.data || [])
  const todayAppointments = (todayApptsResult.data || []).map((appt) => ({
    ...appt,
    lead: appt.lead ? decryptLeadPII(appt.lead as Record<string, unknown>) : appt.lead,
  }))

  const pipelineValue = (pipelineResult.data || []).reduce(
    (s, l) => s + (l.treatment_value || 0),
    0
  )

  return (
    <div className="animate-in fade-in-0 duration-500 space-y-4">
      <OrgGoalsCard />
      <DashboardHome
      userName={profile?.full_name?.split(' ')[0] || 'there'}
      hotLeads={hotLeads}
      todayAppointments={todayAppointments}
      recentLeads={recentLeadsResult.data || []}
      unreadConversations={unreadConvosResult.data || []}
      activeCampaigns={activeCampaignsResult.data || []}
      recentActivities={recentActivitiesResult.data || []}
      kpis={{
        totalLeads: totalLeadsResult.count ?? 0,
        weekLeads: weekLeadsResult.count ?? 0,
        prevWeekLeads: prevWeekLeadsResult.count ?? 0,
        awaitingContact: awaitingContactResult.count ?? 0,
        engaged: engagedResult.count ?? 0,
        pipelineValue,
        upcomingAppointments: upcomingApptsResult.count ?? 0,
        unreadThreads: unreadThreadsResult.count ?? 0,
      }}
      />
    </div>
  )
}
