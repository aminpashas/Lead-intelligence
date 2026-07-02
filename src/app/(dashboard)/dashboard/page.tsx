import { createClient } from '@/lib/supabase/server'
import { DashboardHome } from '@/components/crm/dashboard-home'
import { OrgGoalsCard } from '@/components/crm/org-goals-card'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { decryptLeadPII, decryptLeadsPII } from '@/lib/encryption'
import { generateDailyBrief, type BriefFacts } from '@/lib/ai/daily-brief'
import type { EscalationItem, RiskyAppointmentItem } from '@/components/crm/dashboard/decision-queue'
import type { AgentActivityItem } from '@/components/crm/dashboard/agent-activity'

// Activity types written exclusively by the autopilot/AI paths. Types both staff
// and AI can produce (appointment_scheduled, stage_advanced) are excluded so the
// feed never claims credit for a human's work.
const AI_ACTIVITY_TYPES = [
  'ai_scored',
  'ai_speed_to_lead',
  'escalated_to_human',
  'cross_channel_sms_sent',
  'cross_channel_email_sent',
  'financing_link_sent',
]

// Attaches a decrypted joined lead regardless of whether PostgREST returned the
// relation as an object or a single-element array (its type inference says array,
// a to-one FK join returns an object at runtime — normalize both).
function withDecryptedLead<T extends { lead?: unknown }, L = Record<string, unknown>>(
  rows: T[]
): (Omit<T, 'lead'> & { lead: L | null })[] {
  return rows.map((row) => {
    const raw = Array.isArray(row.lead) ? row.lead[0] : row.lead
    return {
      ...row,
      lead: raw ? (decryptLeadPII(raw as Record<string, unknown>) as L) : null,
    }
  })
}

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
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const threeDaysAgo = new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString()
  const in72h = new Date(now.getTime() + 72 * 60 * 60 * 1000).toISOString()

  // Run all queries in parallel
  const [
    escalationsResult,
    riskyApptsResult,
    staleHotResult,
    aiActivityResult,
    orgResult,
    aiMessages24hResult,
    aiBooked24hResult,
    todayApptsResult,
    unreadConvosResult,
    activeCampaignsResult,
    kpiResult,
    weekLeadsResult,
    activeConvosResult,
  ] = await Promise.all([
    // Pending autopilot escalations — the AI asked for a human decision
    supabase
      .from('escalations')
      .select('id, reason, ai_notes, ai_draft_response, ai_confidence, agent_type, created_at, lead_id, lead:leads!lead_id(id, first_name, last_name, phone)')
      .eq('organization_id', orgId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(5),

    // Unconfirmed high-risk appointments in the next 72h
    supabase
      .from('appointments')
      .select('id, scheduled_at, status, no_show_risk_score, confirmation_received, lead:leads(id, first_name, last_name, phone)')
      .eq('organization_id', orgId)
      .gte('scheduled_at', now.toISOString())
      .lt('scheduled_at', in72h)
      .eq('confirmation_received', false)
      .gte('no_show_risk_score', 60)
      .in('status', ['scheduled'])
      .order('no_show_risk_score', { ascending: false })
      .limit(3),

    // Hot leads going cold — no touch in 72h
    supabase
      .from('leads')
      .select('id, first_name, last_name, phone, ai_score, status, last_contacted_at, last_responded_at')
      .eq('organization_id', orgId)
      .eq('ai_qualification', 'hot')
      .not('status', 'in', '("disqualified","lost","completed","contract_signed")')
      .lt('last_contacted_at', threeDaysAgo)
      .or(`last_responded_at.is.null,last_responded_at.lt.${threeDaysAgo}`)
      .order('ai_score', { ascending: false })
      .limit(3),

    // What the AI actually did — autopilot-only activity types
    supabase
      .from('lead_activities')
      .select('id, activity_type, title, created_at, lead:leads(id, first_name, last_name)')
      .eq('organization_id', orgId)
      .in('activity_type', AI_ACTIVITY_TYPES)
      .order('created_at', { ascending: false })
      .limit(10),

    // Autopilot status for the header pill
    supabase
      .from('organizations')
      .select('autopilot_enabled, autopilot_paused')
      .eq('id', orgId)
      .single(),

    // AI outbound messages, last 24h (distinct leads + today's sends computed below)
    supabase
      .from('messages')
      .select('lead_id, created_at')
      .eq('organization_id', orgId)
      .eq('direction', 'outbound')
      .eq('ai_generated', true)
      .gte('created_at', dayAgo)
      .limit(1000),

    // Appointments the AI booked in the last 24h
    supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('booked_via', 'ai')
      .gte('created_at', dayAgo),

    // Today's appointments
    supabase
      .from('appointments')
      .select('*, lead:leads(id, first_name, last_name, phone)')
      .eq('organization_id', orgId)
      .gte('scheduled_at', todayStart)
      .lt('scheduled_at', todayEnd)
      .in('status', ['scheduled', 'confirmed'])
      .order('scheduled_at', { ascending: true }),

    // Unread conversations (count feeds the KPI chip + brief)
    supabase
      .from('conversations')
      .select('id, unread_count')
      .eq('organization_id', orgId)
      .gt('unread_count', 0)
      .limit(100),

    // Active campaigns
    supabase
      .from('campaigns')
      .select('id, name, status, channel, total_enrolled, total_converted')
      .eq('organization_id', orgId)
      .eq('status', 'active'),

    // KPIs
    supabase
      .from('leads')
      .select('id, status, ai_qualification, treatment_value', { count: 'exact' })
      .eq('organization_id', orgId),

    // Leads this week (for trend)
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('created_at', sevenDaysAgo),

    // Conversations with traffic this week — "watching N conversations"
    supabase
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('last_message_at', sevenDaysAgo),
  ])

  // PII is encrypted at rest — decrypt server-side before rendering. The casts
  // reflect the select strings above; PostgREST responses are untyped here.
  const escalations = withDecryptedLead(escalationsResult.data || []) as unknown as EscalationItem[]
  const riskyAppointments = withDecryptedLead(riskyApptsResult.data || []) as unknown as RiskyAppointmentItem[]
  const staleHotLeads = decryptLeadsPII(staleHotResult.data || [])
  const aiActivities = withDecryptedLead(aiActivityResult.data || []) as unknown as AgentActivityItem[]
  const todayAppointments = withDecryptedLead(todayApptsResult.data || [])

  const allLeads = kpiResult.data || []
  const totalLeads = kpiResult.count ?? allLeads.length
  const hotCount = allLeads.filter((l) => l.ai_qualification === 'hot').length
  const convertedCount = allLeads.filter((l) =>
    ['contract_signed', 'scheduled', 'in_treatment', 'completed'].includes(l.status)
  ).length
  const pipelineValue = allLeads.reduce((s, l) => s + (l.treatment_value || 0), 0)
  const weekLeads = weekLeadsResult.count || 0
  const unreadMessages = (unreadConvosResult.data || []).reduce((s, c) => s + c.unread_count, 0)
  const pendingDecisions = escalations.length + riskyAppointments.length + staleHotLeads.length

  const aiMessages24h = aiMessages24hResult.data || []
  const aiConversations24h = new Set(aiMessages24h.map((m) => m.lead_id)).size
  const aiSendsToday = aiMessages24h.filter((m) => m.created_at >= todayStart).length

  const autopilotEnabled = orgResult.data?.autopilot_enabled ?? false
  const autopilotPaused = orgResult.data?.autopilot_paused ?? false

  const facts: BriefFacts = {
    userName: profile?.full_name?.split(' ')[0] || 'there',
    aiConversations24h,
    aiSendsToday,
    consultsBookedByAi24h: aiBooked24hResult.count || 0,
    pendingDecisions,
    escalations: escalations.length,
    noShowRisks: riskyAppointments.length,
    goingCold: staleHotLeads.length,
    hotLeads: hotCount,
    newLeadsThisWeek: weekLeads,
    unreadMessages,
    todayAppointments: todayAppointments.length,
    pipelineValue,
    activeCampaigns: (activeCampaignsResult.data || []).map((c) => ({
      name: c.name,
      enrolled: c.total_enrolled,
    })),
    autopilotEnabled,
    autopilotPaused,
  }

  const brief = await generateDailyBrief(supabase, { organizationId: orgId, facts })

  return (
    <div className="animate-in fade-in-0 duration-500 space-y-4">
      <OrgGoalsCard />
      <DashboardHome
        userName={facts.userName}
        orgId={orgId}
        brief={brief}
        autopilot={{ enabled: autopilotEnabled, paused: autopilotPaused, sendsToday: aiSendsToday }}
        escalations={escalations}
        riskyAppointments={riskyAppointments}
        staleHotLeads={staleHotLeads}
        aiActivities={aiActivities}
        todayAppointments={todayAppointments}
        watchingCount={activeConvosResult.count || 0}
        kpis={{
          totalLeads,
          hotLeads: hotCount,
          converted: convertedCount,
          pipelineValue,
          weekLeads,
          todayAppointments: todayAppointments.length,
          unreadMessages,
        }}
      />
    </div>
  )
}
