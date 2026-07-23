import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { NextRequest } from 'next/server'
import { requirePermission } from '@/lib/auth/active-org'
import { primaryServiceLine } from '@/lib/leads/service-line'

// GET /api/analytics — Aggregated analytics data for the dashboard
export async function GET(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()

  // Same gate as the /analytics page (analytics:read) — 401/403 otherwise.
  const guard = await requirePermission(supabase, 'analytics:read')
  if ('error' in guard) return guard.error
  const { orgId } = guard

  // Date range params (default 30 days)
  const startParam = request.nextUrl.searchParams.get('start_date')
  const endParam = request.nextUrl.searchParams.get('end_date')
  const startDate = startParam
    ? new Date(startParam).toISOString()
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const endDate = endParam
    ? new Date(endParam).toISOString()
    : new Date().toISOString()

  // Try to use pre-aggregated RPC functions first (faster)
  // Falls back to client-side aggregation if RPC not available
  const [
    kpisRpc,
    trendRpc,
    sourceRpc,
    qualRpc,
    campaignsResult,
    messagesResult,
    appointmentsResult,
  ] = await Promise.allSettled([
    supabase.rpc('get_lead_kpis', { p_org_id: orgId }),
    supabase.rpc('get_lead_trend', { p_org_id: orgId }),
    supabase.rpc('get_source_breakdown', { p_org_id: orgId }),
    supabase.rpc('get_qualification_distribution', { p_org_id: orgId }),

    // Campaign performance (still need full data for detailed view)
    supabase
      .from('campaigns')
      .select('id, name, status, channel, total_enrolled, total_completed, total_converted, total_unsubscribed, created_at, steps:campaign_steps(total_sent, total_delivered, total_opened, total_replied)')
      .eq('organization_id', orgId),

    // Message counts by day (last 30 days)
    supabase
      .from('messages')
      .select('id, direction, channel, status, ai_generated, created_at')
      .eq('organization_id', orgId)
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),

    // Appointments — join the lead columns that classify service line so we can
    // break show/no-show down by implants vs TMJ vs sleep apnea vs other.
    supabase
      .from('appointments')
      .select('id, status, type, scheduled_at, lead:leads(tags, custom_fields, utm_campaign, utm_source, campaign_attribution, landing_page_url)')
      .eq('organization_id', orgId),
  ])

  // Check if RPC functions are available
  const useRpc = kpisRpc.status === 'fulfilled' && !kpisRpc.value.error

  // Always fetch leads: several breakdowns (financing interest, budget range,
  // avg deal size) have NO server-side RPC and are computed here in JS. When
  // the KPI RPC is available we still need these rows — gating this fetch on
  // `!useRpc` left those breakdowns permanently empty in production (where the
  // RPC exists). It also feeds the JS fallback KPI computation when the RPC is
  // unavailable. One org-scoped, indexed query is acceptable for analytics.
  const { data: leadsData } = await supabase
    .from('leads')
    .select('id, status, ai_qualification, ai_score, source_type, treatment_value, actual_revenue, created_at, converted_at, total_messages_sent, total_messages_received, total_emails_sent, total_sms_sent, no_show_count, consultation_date, financing_interest, budget_range')
    .eq('organization_id', orgId)
    .limit(10000)
  const leads: any[] = leadsData || []

  const campaigns = campaignsResult.status === 'fulfilled' ? (campaignsResult.value.data || []) : []
  const messages = messagesResult.status === 'fulfilled' ? (messagesResult.value.data || []) : []
  const appointments = appointmentsResult.status === 'fulfilled' ? (appointmentsResult.value.data || []) : []

  // --- Lead KPIs (RPC or client-side fallback) ---
  let kpis: any
  if (useRpc && kpisRpc.status === 'fulfilled') {
    kpis = kpisRpc.value.data
  } else {
    // Fallback: compute in JS
    const totalLeads = leads.length
    const hotLeads = leads.filter((l: any) => l.ai_qualification === 'hot').length
    const warmLeads = leads.filter((l: any) => l.ai_qualification === 'warm').length
    const convertedLeads = leads.filter((l: any) =>
      ['contract_signed', 'scheduled', 'in_treatment', 'completed'].includes(l.status)
    ).length
    const qualifiedLeads = leads.filter((l: any) =>
      ['qualified', 'consultation_scheduled', 'consultation_completed', 'treatment_presented', 'financing', 'contract_sent', 'contract_signed'].includes(l.status)
    ).length
    kpis = {
      total_leads: totalLeads,
      hot_leads: hotLeads,
      warm_leads: warmLeads,
      qualified_leads: qualifiedLeads,
      converted_leads: convertedLeads,
      total_pipeline: leads.reduce((s: number, l: any) => s + (l.treatment_value || 0), 0),
      total_revenue: leads.reduce((s: number, l: any) => s + (l.actual_revenue || 0), 0),
      avg_score: totalLeads > 0 ? Math.round(leads.reduce((s: number, l: any) => s + (l.ai_score || 0), 0) / totalLeads) : 0,
    }
  }

  // --- Lead Trend (RPC or client-side fallback) ---
  let leadTrend: any
  if (useRpc && trendRpc.status === 'fulfilled' && trendRpc.value.data) {
    leadTrend = trendRpc.value.data
  } else {
    const now = new Date()
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const leadsByDay: Record<string, number> = {}
    const conversionsByDay: Record<string, number> = {}
    for (let i = 0; i < 30; i++) {
      const d = new Date(thirtyDaysAgo.getTime() + i * 24 * 60 * 60 * 1000)
      const key = d.toISOString().split('T')[0]
      leadsByDay[key] = 0
      conversionsByDay[key] = 0
    }
    for (const lead of leads) {
      const day = lead.created_at.split('T')[0]
      if (leadsByDay[day] !== undefined) leadsByDay[day]++
      if (lead.converted_at) {
        const convDay = lead.converted_at.split('T')[0]
        if (conversionsByDay[convDay] !== undefined) conversionsByDay[convDay]++
      }
    }
    leadTrend = Object.entries(leadsByDay).map(([date, count]) => ({
      date,
      leads: count,
      conversions: conversionsByDay[date] || 0,
    }))
  }

  // --- Source breakdown (RPC or client-side fallback) ---
  let sourceBreakdown: any
  if (useRpc && sourceRpc.status === 'fulfilled' && sourceRpc.value.data) {
    sourceBreakdown = sourceRpc.value.data
  } else {
    const sourceMap: Record<string, number> = {}
    for (const lead of leads) {
      const src = lead.source_type || 'unknown'
      sourceMap[src] = (sourceMap[src] || 0) + 1
    }
    sourceBreakdown = Object.entries(sourceMap)
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count)
  }

  // --- AI qualification distribution (RPC or client-side fallback) ---
  let qualificationDistribution: any
  if (useRpc && qualRpc.status === 'fulfilled' && qualRpc.value.data) {
    const qd = qualRpc.value.data
    qualificationDistribution = Object.entries(qd).map(([tier, count]) => ({ tier, count }))
  } else {
    const qualMap: Record<string, number> = { hot: 0, warm: 0, cold: 0, unqualified: 0, unscored: 0 }
    for (const lead of leads) {
      const q = lead.ai_qualification || 'unscored'
      qualMap[q] = (qualMap[q] || 0) + 1
    }
    qualificationDistribution = Object.entries(qualMap).map(([tier, count]) => ({ tier, count }))
  }

  // --- Status distribution (always client-side, lightweight) ---
  const statusMap: Record<string, number> = {}
  for (const lead of leads) {
    statusMap[lead.status] = (statusMap[lead.status] || 0) + 1
  }
  const statusDistribution = Object.entries(statusMap)
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count)

  // --- Campaign performance ---
  const campaignPerformance = campaigns.map((c) => {
    const steps = (c.steps as any[]) || []
    const totalSent = steps.reduce((s, st) => s + (st.total_sent || 0), 0)
    const totalDelivered = steps.reduce((s, st) => s + (st.total_delivered || 0), 0)
    const totalOpened = steps.reduce((s, st) => s + (st.total_opened || 0), 0)
    const totalReplied = steps.reduce((s, st) => s + (st.total_replied || 0), 0)
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      channel: c.channel,
      enrolled: c.total_enrolled,
      completed: c.total_completed,
      converted: c.total_converted,
      unsubscribed: c.total_unsubscribed,
      totalSent,
      totalDelivered,
      totalOpened,
      totalReplied,
      deliveryRate: totalSent > 0 ? (totalDelivered / totalSent * 100) : 0,
      openRate: totalDelivered > 0 ? (totalOpened / totalDelivered * 100) : 0,
      replyRate: totalDelivered > 0 ? (totalReplied / totalDelivered * 100) : 0,
      conversionRate: c.total_enrolled > 0 ? (c.total_converted / c.total_enrolled * 100) : 0,
    }
  })

  // --- Message activity (last 30 days) ---
  const now = new Date()
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const msgByDay: Record<string, { outbound: number; inbound: number }> = {}
  for (let i = 0; i < 30; i++) {
    const d = new Date(thirtyDaysAgo.getTime() + i * 24 * 60 * 60 * 1000)
    const key = d.toISOString().split('T')[0]
    msgByDay[key] = { outbound: 0, inbound: 0 }
  }
  for (const msg of messages) {
    const day = msg.created_at.split('T')[0]
    if (msgByDay[day]) {
      if (msg.direction === 'outbound') msgByDay[day].outbound++
      else msgByDay[day].inbound++
    }
  }
  const messageTrend = Object.entries(msgByDay).map(([date, counts]) => ({
    date,
    ...counts,
  }))

  // Messages stats
  const totalOutbound = messages.filter((m: any) => m.direction === 'outbound').length
  const totalInbound = messages.filter((m: any) => m.direction === 'inbound').length
  const aiMessages = messages.filter((m: any) => m.ai_generated).length

  // Appointment stats
  const scheduledAppts = appointments.filter((a: any) => ['scheduled', 'confirmed'].includes(a.status)).length
  const completedAppts = appointments.filter((a: any) => a.status === 'completed').length
  const noShowAppts = appointments.filter((a: any) => a.status === 'no_show').length

  // Per-service-line appointment outcomes (implants vs TMJ vs sleep apnea vs
  // other). Each appointment's lead is classified with the SAME logic the /leads
  // table and pipeline chips use (primaryServiceLine → implants is the residual
  // default), so a no-show % is comparable across the app. Show/no-show rate
  // denominator is completed + no_show — upcoming appts are excluded, matching
  // the org-wide showRate below.
  const apptLineMap: Record<string, { scheduled: number; completed: number; noShow: number }> = {}
  for (const a of appointments as any[]) {
    const key = a.lead ? primaryServiceLine(a.lead) : 'unknown'
    const bucket = (apptLineMap[key] ??= { scheduled: 0, completed: 0, noShow: 0 })
    if (['scheduled', 'confirmed'].includes(a.status)) bucket.scheduled++
    else if (a.status === 'completed') bucket.completed++
    else if (a.status === 'no_show') bucket.noShow++
  }
  const appointmentsByServiceLine = Object.entries(apptLineMap)
    .map(([serviceLine, c]) => {
      const resolved = c.completed + c.noShow
      return {
        serviceLine,
        scheduled: c.scheduled,
        completed: c.completed,
        noShow: c.noShow,
        showRate: resolved > 0 ? (c.completed / resolved * 100) : 0,
        noShowRate: resolved > 0 ? (c.noShow / resolved * 100) : 0,
      }
    })
    .sort((a, b) => (b.completed + b.noShow) - (a.completed + a.noShow))

  // Financing & budget breakdowns (computed here in JS — no server-side RPC)
  const financingMap: Record<string, number> = {}
  const budgetMap: Record<string, number> = {}
  for (const lead of leads) {
    if (lead.financing_interest) {
      financingMap[lead.financing_interest] = (financingMap[lead.financing_interest] || 0) + 1
    }
    if (lead.budget_range) {
      budgetMap[lead.budget_range] = (budgetMap[lead.budget_range] || 0) + 1
    }
  }

  // --- New analytics: response time, source ROI, pipeline velocity, forecasting ---
  const [responseTimeRpc, sourceRoiRpc, velocityRpc] = await Promise.allSettled([
    supabase.rpc('get_response_time_metrics', { p_org_id: orgId, p_start: startDate, p_end: endDate }),
    supabase.rpc('get_source_roi', { p_org_id: orgId, p_start: startDate, p_end: endDate }),
    supabase.rpc('get_pipeline_velocity', { p_org_id: orgId, p_start: startDate, p_end: endDate }),
  ])

  const responseTime = responseTimeRpc.status === 'fulfilled' && !responseTimeRpc.value.error
    ? responseTimeRpc.value.data
    : { avg_first_contact_minutes: 0, avg_response_minutes: 0, contacted_within_5min_pct: 0, distribution: [] }

  const sourceRoi = sourceRoiRpc.status === 'fulfilled' && !sourceRoiRpc.value.error
    ? sourceRoiRpc.value.data
    : []

  const pipelineVelocity = velocityRpc.status === 'fulfilled' && !velocityRpc.value.error
    ? velocityRpc.value.data
    : []

  // Revenue forecasting from current pipeline
  const hotLeadCount = kpis.hot_leads ?? kpis.hotLeads ?? 0
  const warmLeadCount = kpis.warm_leads ?? kpis.warmLeads ?? 0
  const coldLeadCount = kpis.cold_leads ?? kpis.coldLeads ?? 0
  const avgDealSize = leads.length > 0
    ? leads.reduce((s: number, l: { treatment_value?: number }) => s + (l.treatment_value || 0), 0) / Math.max(1, leads.filter((l: { treatment_value?: number }) => l.treatment_value && l.treatment_value > 0).length)
    : 25000 // default assumption

  const forecasting = {
    hot: { count: hotLeadCount, probability: 0.8, projected: Math.round(hotLeadCount * avgDealSize * 0.8) },
    warm: { count: warmLeadCount, probability: 0.4, projected: Math.round(warmLeadCount * avgDealSize * 0.4) },
    cold: { count: coldLeadCount, probability: 0.1, projected: Math.round(coldLeadCount * avgDealSize * 0.1) },
    total_projected: Math.round(
      hotLeadCount * avgDealSize * 0.8 +
      warmLeadCount * avgDealSize * 0.4 +
      coldLeadCount * avgDealSize * 0.1
    ),
    avg_deal_size: Math.round(avgDealSize),
  }

  // Normalize KPI field names
  const totalLeads = kpis.total_leads ?? kpis.totalLeads ?? 0
  const convertedLeads = kpis.converted_leads ?? kpis.convertedLeads ?? 0
  const qualifiedLeads = kpis.qualified_leads ?? kpis.qualifiedLeads ?? 0

  // ── Connector Health (last 7 days) ──
  let connectorHealth: any = null
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data: connectorEvents } = await supabase
      .from('connector_events')
      .select('connector_type, event_type, success, dispatched_at')
      .eq('organization_id', orgId)
      .gte('dispatched_at', sevenDaysAgo)

    if (connectorEvents && connectorEvents.length > 0) {
      const byConnector: Record<string, { total: number; success: number; failed: number; events: Record<string, number> }> = {}
      for (const ev of connectorEvents) {
        if (!byConnector[ev.connector_type]) {
          byConnector[ev.connector_type] = { total: 0, success: 0, failed: 0, events: {} }
        }
        byConnector[ev.connector_type].total++
        if (ev.success) byConnector[ev.connector_type].success++
        else byConnector[ev.connector_type].failed++
        byConnector[ev.connector_type].events[ev.event_type] = (byConnector[ev.connector_type].events[ev.event_type] || 0) + 1
      }

      connectorHealth = {
        total_events: connectorEvents.length,
        total_success: connectorEvents.filter(e => e.success).length,
        total_failed: connectorEvents.filter(e => !e.success).length,
        connectors: Object.entries(byConnector).map(([type, stats]) => ({
          type,
          ...stats,
          success_rate: stats.total > 0 ? Math.round(stats.success / stats.total * 100) : 0,
          top_event: Object.entries(stats.events).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
        })),
      }
    }
  } catch {
    // connector_events table may not exist yet — graceful degradation
  }

  return NextResponse.json({
    kpis: {
      totalLeads,
      hotLeads: kpis.hot_leads ?? kpis.hotLeads ?? 0,
      warmLeads: kpis.warm_leads ?? kpis.warmLeads ?? 0,
      qualifiedLeads,
      convertedLeads,
      totalPipeline: kpis.total_pipeline ?? kpis.totalPipeline ?? 0,
      totalRevenue: kpis.total_revenue ?? kpis.totalRevenue ?? 0,
      avgScore: kpis.avg_score ?? kpis.avgScore ?? 0,
      conversionRate: totalLeads > 0 ? (convertedLeads / totalLeads * 100) : 0,
      qualificationRate: totalLeads > 0 ? (qualifiedLeads / totalLeads * 100) : 0,
    },
    leadTrend,
    messageTrend,
    sourceBreakdown,
    qualificationDistribution,
    statusDistribution,
    campaignPerformance,
    messaging: {
      totalOutbound,
      totalInbound,
      aiMessages,
      aiPercentage: totalOutbound > 0 ? (aiMessages / totalOutbound * 100) : 0,
    },
    appointments: {
      scheduled: scheduledAppts,
      completed: completedAppts,
      noShow: noShowAppts,
      // Show rate is completed / (completed + no-show). Guard the ACTUAL
      // denominator — guarding on `scheduled + …` let an org with only
      // upcoming appts (completed = no_show = 0) reach 0/0 = NaN, which
      // JSON-serializes to null and crashed the client's `.toFixed()`.
      showRate: (completedAppts + noShowAppts) > 0
        ? (completedAppts / (completedAppts + noShowAppts) * 100) : 0,
    },
    // Show / no-show broken out by service line (implants vs TMJ vs sleep apnea
    // vs other), so the practice can see e.g. what % of implant consults no-show
    // vs TMJ. Sorted by resolved-appointment volume.
    appointmentsByServiceLine,
    financingBreakdown: Object.entries(financingMap).map(([type, count]) => ({ type, count })),
    budgetBreakdown: Object.entries(budgetMap).map(([range, count]) => ({ range, count })),
    responseTime,
    sourceRoi,
    pipelineVelocity,
    forecasting,
    connectorHealth,
    dateRange: { start: startDate, end: endDate },
  })
}
