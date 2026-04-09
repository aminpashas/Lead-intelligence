import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// GET /api/analytics — Aggregated analytics data for the dashboard
export async function GET() {
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const orgId = profile.organization_id

  // Run all queries in parallel
  const [
    leadsResult,
    campaignsResult,
    messagesResult,
    appointmentsResult,
  ] = await Promise.all([
    // All leads with key fields for aggregation
    supabase
      .from('leads')
      .select('id, status, ai_qualification, ai_score, source_type, treatment_value, actual_revenue, created_at, converted_at, total_messages_sent, total_messages_received, total_emails_sent, total_sms_sent, no_show_count, consultation_date, financing_interest, budget_range')
      .eq('organization_id', orgId),

    // Campaign performance
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

    // Appointments
    supabase
      .from('appointments')
      .select('id, status, type, scheduled_at')
      .eq('organization_id', orgId),
  ])

  const leads = leadsResult.data || []
  const campaigns = campaignsResult.data || []
  const messages = messagesResult.data || []
  const appointments = appointmentsResult.data || []

  // --- Aggregate leads by day (last 30 days) ---
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

  const leadTrend = Object.entries(leadsByDay).map(([date, count]) => ({
    date,
    leads: count,
    conversions: conversionsByDay[date] || 0,
  }))

  // --- Source breakdown ---
  const sourceMap: Record<string, number> = {}
  for (const lead of leads) {
    const src = lead.source_type || 'unknown'
    sourceMap[src] = (sourceMap[src] || 0) + 1
  }
  const sourceBreakdown = Object.entries(sourceMap)
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count)

  // --- AI qualification distribution ---
  const qualMap: Record<string, number> = { hot: 0, warm: 0, cold: 0, unqualified: 0, unscored: 0 }
  for (const lead of leads) {
    const q = lead.ai_qualification || 'unscored'
    qualMap[q] = (qualMap[q] || 0) + 1
  }
  const qualificationDistribution = Object.entries(qualMap).map(([tier, count]) => ({ tier, count }))

  // --- Status distribution ---
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

  // --- KPI calculations ---
  const totalLeads = leads.length
  const hotLeads = leads.filter((l) => l.ai_qualification === 'hot').length
  const warmLeads = leads.filter((l) => l.ai_qualification === 'warm').length
  const convertedLeads = leads.filter((l) =>
    ['contract_signed', 'scheduled', 'in_treatment', 'completed'].includes(l.status)
  ).length
  const qualifiedLeads = leads.filter((l) =>
    ['qualified', 'consultation_scheduled', 'consultation_completed', 'treatment_presented', 'financing', 'contract_sent', 'contract_signed'].includes(l.status)
  ).length
  const totalPipeline = leads.reduce((s, l) => s + (l.treatment_value || 0), 0)
  const totalRevenue = leads.reduce((s, l) => s + (l.actual_revenue || 0), 0)
  const avgScore = leads.length > 0
    ? leads.reduce((s, l) => s + (l.ai_score || 0), 0) / leads.length
    : 0

  // Messages stats
  const totalOutbound = messages.filter((m) => m.direction === 'outbound').length
  const totalInbound = messages.filter((m) => m.direction === 'inbound').length
  const aiMessages = messages.filter((m) => m.ai_generated).length

  // Appointment stats
  const scheduledAppts = appointments.filter((a) => ['scheduled', 'confirmed'].includes(a.status)).length
  const completedAppts = appointments.filter((a) => a.status === 'completed').length
  const noShowAppts = appointments.filter((a) => a.status === 'no_show').length

  // Financing breakdown
  const financingMap: Record<string, number> = {}
  for (const lead of leads) {
    if (lead.financing_interest) {
      financingMap[lead.financing_interest] = (financingMap[lead.financing_interest] || 0) + 1
    }
  }

  // Budget breakdown
  const budgetMap: Record<string, number> = {}
  for (const lead of leads) {
    if (lead.budget_range) {
      budgetMap[lead.budget_range] = (budgetMap[lead.budget_range] || 0) + 1
    }
  }

  return NextResponse.json({
    kpis: {
      totalLeads,
      hotLeads,
      warmLeads,
      qualifiedLeads,
      convertedLeads,
      totalPipeline,
      totalRevenue,
      avgScore: Math.round(avgScore),
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
      showRate: (scheduledAppts + completedAppts + noShowAppts) > 0
        ? (completedAppts / (completedAppts + noShowAppts) * 100) : 0,
    },
    financingBreakdown: Object.entries(financingMap).map(([type, count]) => ({ type, count })),
    budgetBreakdown: Object.entries(budgetMap).map(([range, count]) => ({ range, count })),
  })
}
