import { createClient } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { DashboardHome } from '@/components/crm/dashboard-home'
import { FrontDeskToday } from '@/components/crm/front-desk-today'
import { OpsDashboard } from '@/components/crm/ops-dashboard'
import { OrgGoalsCard } from '@/components/crm/org-goals-card'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { dashboardVariant } from '@/lib/auth/permissions'
import { decryptLeadPII, decryptLeadsPII } from '@/lib/encryption'
import { PAID_AD_CHANNEL_OR_FILTER } from '@/lib/attribution'
import { resolveLeadDateRange } from '@/lib/leads/date-range'

// The dashboard "Pipeline" KPI is the probability-weighted forecast of the open
// deals curated on the In-Closing board (closing_book): Σ(case_value × close_probability).
// It deliberately does NOT sum leads.treatment_value — that column is only ever
// populated when a case *completes*, so summing it showed the booked revenue of
// already-closed cases mislabeled as open pipeline (e.g. SF's "$23k" = 7 completed
// cases). close_probability is stored as a 0–1 fraction. closing_book is a small
// curated table, so reducing rows in JS is safe from the 1000-row cap.
async function weightedPipelineForecast(supabase: SupabaseClient, orgId: string): Promise<number> {
  const { data } = await supabase
    .from('closing_book')
    .select('case_value, close_probability')
    .eq('organization_id', orgId)
  return (data || []).reduce(
    (s, d) => s + (Number(d.case_value) || 0) * (Number(d.close_probability) || 0),
    0
  )
}

// The dashboard shows a different home depending on who is looking:
//  - agency_admin        → AI command center (company control room)
//  - clinical front-desk → the Today view (consults + per-visit prep)
//  - practice admin/ops  → the command center for now (Phase 3 gives them a
//                          dedicated pipeline/funnel ops board)
// See dashboardVariant() for the role→variant mapping.
export default async function DashboardPage() {
  const supabase = await createClient()

  // The user's display name comes from their own profile…
  const { data: profile } = await getOwnProfile(supabase, 'full_name')

  // …but the data is scoped to the effective org, which honors an agency_admin's
  // entered client account (see resolveActiveOrg).
  const { orgId, role } = await resolveActiveOrg(supabase)
  if (!orgId) return null

  const userName = profile?.full_name?.split(' ')[0] || 'there'
  const variant = dashboardVariant(role || 'member')

  if (variant === 'frontdesk') {
    return <FrontDeskDashboard supabase={supabase} orgId={orgId} userName={userName} />
  }

  if (variant === 'ops') {
    return <OpsDashboardView supabase={supabase} orgId={orgId} userName={userName} />
  }

  // agency_admin → the AI command center (company control room).
  return <AgencyDashboard supabase={supabase} orgId={orgId} userName={userName} />
}

// ── Practice-admin (ops) home: pipeline stages + funnel + booked consults ────
async function OpsDashboardView({
  supabase,
  orgId,
  userName,
}: {
  supabase: SupabaseClient
  orgId: string
  userName: string
}) {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const sevenDaysAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()

  const [
    stagesResult,
    totalLeadsResult,
    weekLeadsResult,
    awaitingContactResult,
    bookedResult,
    awaitingReplyResult,
    pipelineValue,
    upcomingResult,
    hotLeadsResult,
  ] = await Promise.all([
    // Leads-by-stage via the RPC (aggregates in Postgres — no 1000-row cap).
    supabase.rpc('pipeline_stage_counts', { p_org: orgId }),

    supabase.from('leads').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),

    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('created_at', sevenDaysAgo)
      .or(PAID_AD_CHANNEL_OR_FILTER),

    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('created_at', sevenDaysAgo)
      .is('last_contacted_at', null)
      .or(PAID_AD_CHANNEL_OR_FILTER),

    supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('scheduled_at', todayStart)
      .lt('scheduled_at', sevenDaysAhead)
      .in('status', ['scheduled', 'confirmed']),

    // Same "patient is waiting on us" signal the agency dashboard uses — see the
    // note there on why conversations.unread_count can't be trusted.
    supabase.rpc('conversations_awaiting_reply', {
      p_org: orgId,
      p_since: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    }),

    // Pipeline value — probability-weighted forecast from the In-Closing board.
    weightedPipelineForecast(supabase, orgId),

    supabase
      .from('appointments')
      .select('id, type, status, scheduled_at, confirmation_received, confirmed_at, lead:leads(id, first_name, last_name)')
      .eq('organization_id', orgId)
      .gte('scheduled_at', todayStart)
      .lt('scheduled_at', sevenDaysAhead)
      .in('status', ['scheduled', 'confirmed'])
      .order('scheduled_at', { ascending: true })
      .limit(10),

    supabase
      .from('leads')
      .select('id, first_name, last_name, ai_score, ai_qualification')
      .eq('organization_id', orgId)
      .eq('ai_qualification', 'hot')
      .not('status', 'in', '("disqualified","lost","completed","contract_signed")')
      .order('ai_score', { ascending: false })
      .limit(6),
  ])

  // Positions 11+ are a legacy GHL-mirror pipeline (duplicate stage names); the
  // canonical sales funnel is positions 0–10. Keep the real funnel only.
  type StageRow = { stage_id: string; name: string; stage_position: number; lead_count: number }
  const stages = ((stagesResult.data as StageRow[] | null) || []).filter((s) => s.stage_position <= 10)

  const upcomingConsults = (upcomingResult.data || []).map((appt: Record<string, any>) => ({
    ...appt,
    lead: appt.lead ? decryptLeadPII(appt.lead as Record<string, unknown>) : appt.lead,
  }))
  const hotLeads = decryptLeadsPII(hotLeadsResult.data || [])

  return (
    <OpsDashboard
      userName={userName}
      kpis={{
        totalLeads: totalLeadsResult.count ?? 0,
        weekLeads: weekLeadsResult.count ?? 0,
        bookedThisWeek: bookedResult.count ?? 0,
        awaitingContact: awaitingContactResult.count ?? 0,
        awaitingReplyCount: awaitingReplyResult.data?.length ?? 0,
        pipelineValue,
      }}
      stages={stages}
      upcomingConsults={upcomingConsults}
      hotLeads={hotLeads}
    />
  )
}

// ── Front-desk (clinical) home: today's consults with AI prep ───────────────
async function FrontDeskDashboard({
  supabase,
  orgId,
  userName,
}: {
  supabase: SupabaseClient
  orgId: string
  userName: string
}) {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString()
  const sevenDaysAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()

  // The prequal + conversation-analysis fields are the whole point of this view —
  // they turn "who's coming in" into "what to know before they walk in".
  const CONSULT_LEAD_SELECT =
    'id, first_name, last_name, phone, ai_score, ai_qualification, ai_summary, ' +
    'conversation_intent, conversation_sentiment, conversation_red_flag, ' +
    'primary_objection, treatment_value'

  const [todayResult, upcomingResult, weekCountResult] = await Promise.all([
    supabase
      .from('appointments')
      .select(`*, lead:leads(${CONSULT_LEAD_SELECT})`)
      .eq('organization_id', orgId)
      .gte('scheduled_at', todayStart)
      .lt('scheduled_at', todayEnd)
      .in('status', ['scheduled', 'confirmed'])
      .order('scheduled_at', { ascending: true }),

    supabase
      .from('appointments')
      .select('id, type, status, scheduled_at, confirmation_received, confirmed_at, lead:leads(id, first_name, last_name)')
      .eq('organization_id', orgId)
      .gte('scheduled_at', todayEnd)
      .lt('scheduled_at', sevenDaysAhead)
      .in('status', ['scheduled', 'confirmed'])
      .order('scheduled_at', { ascending: true })
      .limit(20),

    supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('scheduled_at', todayStart)
      .lt('scheduled_at', sevenDaysAhead)
      .in('status', ['scheduled', 'confirmed']),
  ])

  // Decrypt the joined lead PII server-side before it reaches the client.
  // Loosely typed (like the command-center rows) — the appointment shape varies
  // by query and the client component reads fields defensively.
  const decryptConsult = (appt: Record<string, any>): Record<string, any> => ({
    ...appt,
    lead: appt.lead ? decryptLeadPII(appt.lead as Record<string, unknown>) : appt.lead,
  })

  const todayConsults = (todayResult.data || []).map(decryptConsult)
  const upcomingConsults = (upcomingResult.data || []).map(decryptConsult)

  const confirmedCount = todayConsults.filter(
    (c) => c.status === 'confirmed' || c.confirmation_received || c.confirmed_at
  ).length

  return (
    <div className="animate-in fade-in-0 duration-500">
      <FrontDeskToday
        userName={userName}
        todayConsults={todayConsults}
        upcomingConsults={upcomingConsults}
        stats={{
          todayCount: todayConsults.length,
          confirmedCount,
          needsConfirmationCount: todayConsults.length - confirmedCount,
          weekCount: weekCountResult.count ?? 0,
        }}
      />
    </div>
  )
}

// ── Agency / ops home: the AI command center ────────────────────────────────
async function AgencyDashboard({
  supabase,
  orgId,
  userName,
}: {
  supabase: SupabaseClient
  orgId: string
  userName: string
}) {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString()
  const sevenDaysAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()

  // "This week" uses the SAME practice-timezone calendar-day window as the Leads
  // view's `range=7d` preset, so each KPI card's count matches the row count you
  // land on when you click it (see resolveLeadDateRange + the card hrefs).
  // `weekStart` = midnight 6 calendar days ago; `prevWeekStart` = 13 days ago,
  // giving a clean prior 7-day block for the trend line.
  const weekStart = resolveLeadDateRange('7d', now)!.gte
  const prevWeekStart = resolveLeadDateRange('14d', now)!.gte

  // How far back the "waiting on us" rail looks. 30 days keeps the list
  // actionable — a patient who went quiet three months ago is a re-engagement
  // campaign, not an unanswered message — and bounds the RPC's message scan.
  const awaitingReplySince = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()

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
    pipelineValue,
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

    // Threads where the patient spoke last and is still waiting on us.
    //
    // This deliberately does NOT filter on conversations.unread_count. That
    // counter is only ever *cleared* (zeroed when a thread is opened) and is
    // incremented only on the Twilio webhook path — the GHL ingest, which
    // carries nearly all volume, never touches it. Keying the rail on it
    // surfaced 35 threads, 34 of them stale 2025 backfill artifacts, while
    // hundreds of live threads awaiting a reply stayed invisible.
    supabase.rpc('conversations_awaiting_reply', {
      p_org: orgId,
      p_since: awaitingReplySince,
    }),

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
    // campaign leads, not imported nurturing-DB / organic / direct. Window matches
    // the card's `/leads?range=7d&channel=paid` deep-link.
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('created_at', weekStart)
      .or(PAID_AD_CHANNEL_OR_FILTER),

    // Same count for the prior week, so the card can show a real trend.
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('created_at', prevWeekStart)
      .lt('created_at', weekStart)
      .or(PAID_AD_CHANNEL_OR_FILTER),

    // Speed-to-lead gap: this week's ad leads nobody has reached out to yet.
    // Matches `/leads?range=7d&channel=paid&uncontacted=1`.
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('created_at', weekStart)
      .is('last_contacted_at', null)
      .or(PAID_AD_CHANNEL_OR_FILTER),

    // Leads that replied to us this week (any channel). Matches `/leads?replied=7d`.
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('last_responded_at', weekStart),

    // Appointments on the books for the coming week (today included).
    supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('scheduled_at', todayStart)
      .lt('scheduled_at', sevenDaysAhead)
      .in('status', ['scheduled', 'confirmed']),

    // Pipeline value — probability-weighted forecast from the In-Closing board.
    weightedPipelineForecast(supabase, orgId),
  ])

  // PII is encrypted at rest — decrypt server-side before rendering.
  const hotLeads = decryptLeadsPII(hotLeadsResult.data || [])

  // The RPC returns flat rows (names encrypted, same as a PostgREST select).
  // Decrypt, then re-nest under `lead` so the card keeps its existing shape.
  // The full set is the count; the rail renders the 5 most recent.
  const awaitingReply = decryptLeadsPII(
    (unreadConvosResult.data || []) as Array<Record<string, unknown>>
  ).map((row: Record<string, any>) => ({
    ...row,
    lead: { id: row.lead_id, first_name: row.first_name, last_name: row.last_name },
  }))
  const todayAppointments = (todayApptsResult.data || []).map((appt) => ({
    ...appt,
    lead: appt.lead ? decryptLeadPII(appt.lead as Record<string, unknown>) : appt.lead,
  }))

  return (
    <div className="animate-in fade-in-0 duration-500 space-y-4">
      <OrgGoalsCard />
      <DashboardHome
        userName={userName}
        hotLeads={hotLeads}
        todayAppointments={todayAppointments}
        recentLeads={recentLeadsResult.data || []}
        awaitingReply={awaitingReply.slice(0, 5)}
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
          awaitingReplyCount: awaitingReply.length,
        }}
      />
    </div>
  )
}
