/**
 * Predictive Analytics Engine
 *
 * Uses historical lead data to generate predictions:
 *   1. Conversion probability — likelihood a lead converts to a patient
 *   2. Optimal contact time — best day/hour to reach each lead
 *   3. No-show risk — probability a scheduled lead will no-show
 *   4. Revenue forecast — projected monthly revenue from current pipeline
 *   5. Lead velocity — acceleration/deceleration of lead flow
 *
 * All predictions are statistical (not ML) — they use Bayesian-style
 * base rate × signal adjustments. This runs entirely in-process with
 * no external API calls.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type ConversionPrediction = {
  lead_id: string
  probability: number         // 0-1
  confidence: number          // 0-1
  top_factors: Array<{ factor: string; impact: number; direction: 'positive' | 'negative' }>
  predicted_close_days: number | null
}

export type OptimalContactWindow = {
  best_day: string            // 'Monday', 'Tuesday', etc.
  best_hour: number           // 0-23
  response_rate_by_hour: Record<number, number>
  response_rate_by_day: Record<string, number>
}

export type NoShowRisk = {
  lead_id: string
  risk_score: number          // 0-100
  risk_level: 'low' | 'medium' | 'high'
  risk_factors: string[]
}

export type RevenueProjection = {
  current_month: number
  next_month: number
  three_month: number
  by_tier: {
    hot: { count: number; projected: number; probability: number }
    warm: { count: number; projected: number; probability: number }
    cold: { count: number; projected: number; probability: number }
  }
  avg_deal_size: number
  avg_days_to_close: number
}

export type LeadVelocity = {
  current_week: number
  previous_week: number
  change_pct: number
  trend: 'accelerating' | 'stable' | 'decelerating'
  qualified_velocity: number   // qualified leads per week
  conversion_velocity: number  // conversions per week
}

export type PredictiveInsights = {
  revenue_projection: RevenueProjection
  optimal_contact: OptimalContactWindow
  lead_velocity: LeadVelocity
  top_conversion_leads: ConversionPrediction[]
  at_risk_appointments: NoShowRisk[]
  generated_at: string
}

// ═══════════════════════════════════════════════════════════════
// MAIN PREDICTION ENGINE
// ═══════════════════════════════════════════════════════════════

export async function generatePredictiveInsights(
  supabase: SupabaseClient,
  organizationId: string
): Promise<PredictiveInsights> {
  const [leads, messages, appointments] = await Promise.all([
    fetchLeadData(supabase, organizationId),
    fetchMessageData(supabase, organizationId),
    fetchAppointmentData(supabase, organizationId),
  ])

  const revenueProjection = computeRevenueProjection(leads)
  const optimalContact = computeOptimalContactWindow(messages)
  const leadVelocity = computeLeadVelocity(leads)
  const topConversionLeads = computeConversionProbabilities(leads).slice(0, 20)
  const atRiskAppointments = computeNoShowRisk(leads, appointments)

  return {
    revenue_projection: revenueProjection,
    optimal_contact: optimalContact,
    lead_velocity: leadVelocity,
    top_conversion_leads: topConversionLeads,
    at_risk_appointments: atRiskAppointments,
    generated_at: new Date().toISOString(),
  }
}

// ═══════════════════════════════════════════════════════════════
// DATA FETCHING
// ═══════════════════════════════════════════════════════════════

type LeadRow = {
  id: string
  status: string
  ai_qualification: string
  ai_score: number
  treatment_value: number | null
  actual_revenue: number | null
  created_at: string
  converted_at: string | null
  qualified_at: string | null
  last_contacted_at: string | null
  last_responded_at: string | null
  response_time_avg_minutes: number | null
  total_messages_sent: number
  total_messages_received: number
  no_show_count: number
  consultation_date: string | null
  engagement_score: number
  financing_interest: string | null
  budget_range: string | null
  source_type: string | null
}

type MessageRow = {
  direction: string
  created_at: string
  status: string
}

type AppointmentRow = {
  id: string
  lead_id: string
  status: string
  scheduled_at: string
  no_show_risk_score: number
  confirmation_received: boolean
}

async function fetchLeadData(supabase: SupabaseClient, orgId: string): Promise<LeadRow[]> {
  const { data } = await supabase
    .from('leads')
    .select('id, status, ai_qualification, ai_score, treatment_value, actual_revenue, created_at, converted_at, qualified_at, last_contacted_at, last_responded_at, response_time_avg_minutes, total_messages_sent, total_messages_received, no_show_count, consultation_date, engagement_score, financing_interest, budget_range, source_type')
    .eq('organization_id', orgId)
    .limit(10000)
  return (data || []) as LeadRow[]
}

async function fetchMessageData(supabase: SupabaseClient, orgId: string): Promise<MessageRow[]> {
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
  const { data } = await supabase
    .from('messages')
    .select('direction, created_at, status')
    .eq('organization_id', orgId)
    .gte('created_at', sixtyDaysAgo)
    .limit(50000)
  return (data || []) as MessageRow[]
}

async function fetchAppointmentData(supabase: SupabaseClient, orgId: string): Promise<AppointmentRow[]> {
  const { data } = await supabase
    .from('appointments')
    .select('id, lead_id, status, scheduled_at, no_show_risk_score, confirmation_received')
    .eq('organization_id', orgId)
    .in('status', ['scheduled', 'confirmed'])
  return (data || []) as AppointmentRow[]
}

// ═══════════════════════════════════════════════════════════════
// CONVERSION PROBABILITY
// ═══════════════════════════════════════════════════════════════

const CONVERTED_STATUSES = new Set([
  'contract_signed', 'scheduled', 'in_treatment', 'completed'
])

function computeConversionProbabilities(leads: LeadRow[]): ConversionPrediction[] {
  // Calculate historical base conversion rate
  const totalLeads = leads.length
  const convertedLeads = leads.filter(l => CONVERTED_STATUSES.has(l.status)).length
  const baseRate = totalLeads > 0 ? convertedLeads / totalLeads : 0.15

  // Only score active leads (not already converted or lost)
  const activeLeads = leads.filter(l =>
    !CONVERTED_STATUSES.has(l.status) &&
    !['lost', 'disqualified', 'completed'].includes(l.status)
  )

  return activeLeads
    .map(lead => scoreConversionProbability(lead, baseRate, leads))
    .sort((a, b) => b.probability - a.probability)
}

function scoreConversionProbability(
  lead: LeadRow,
  baseRate: number,
  allLeads: LeadRow[]
): ConversionPrediction {
  let score = baseRate
  const factors: ConversionPrediction['top_factors'] = []

  // Factor 1: AI qualification tier
  const qualMult: Record<string, number> = { hot: 2.5, warm: 1.5, cold: 0.5, unqualified: 0.2, unscored: 0.8 }
  const qm = qualMult[lead.ai_qualification] || 1
  score *= qm
  if (qm > 1) factors.push({ factor: `AI qualification: ${lead.ai_qualification}`, impact: qm - 1, direction: 'positive' })
  if (qm < 1) factors.push({ factor: `AI qualification: ${lead.ai_qualification}`, impact: 1 - qm, direction: 'negative' })

  // Factor 2: AI score (0-100)
  if (lead.ai_score >= 70) {
    const boost = 1 + (lead.ai_score - 70) / 100
    score *= boost
    factors.push({ factor: `High AI score (${lead.ai_score})`, impact: boost - 1, direction: 'positive' })
  } else if (lead.ai_score < 30 && lead.ai_score > 0) {
    score *= 0.5
    factors.push({ factor: `Low AI score (${lead.ai_score})`, impact: 0.5, direction: 'negative' })
  }

  // Factor 3: Engagement (response rate)
  if (lead.total_messages_sent > 0) {
    const responseRate = lead.total_messages_received / lead.total_messages_sent
    if (responseRate > 0.5) {
      score *= 1.4
      factors.push({ factor: 'High message response rate', impact: 0.4, direction: 'positive' })
    } else if (responseRate < 0.1 && lead.total_messages_sent > 3) {
      score *= 0.3
      factors.push({ factor: 'Very low response rate', impact: 0.7, direction: 'negative' })
    }
  }

  // Factor 4: Financing interest
  if (lead.financing_interest === 'cash_pay') {
    score *= 1.3
    factors.push({ factor: 'Cash pay (no financing friction)', impact: 0.3, direction: 'positive' })
  } else if (lead.financing_interest === 'financing_needed') {
    score *= 1.1
    factors.push({ factor: 'Actively seeking financing', impact: 0.1, direction: 'positive' })
  }

  // Factor 5: Treatment value set (shows progression)
  if (lead.treatment_value && lead.treatment_value > 0) {
    score *= 1.5
    factors.push({ factor: 'Treatment value assigned', impact: 0.5, direction: 'positive' })
  }

  // Factor 6: No-show history
  if (lead.no_show_count > 0) {
    const penalty = Math.max(0.3, 1 - lead.no_show_count * 0.25)
    score *= penalty
    factors.push({ factor: `${lead.no_show_count} no-show(s)`, impact: 1 - penalty, direction: 'negative' })
  }

  // Factor 7: Lead age (freshness decay)
  const ageMs = Date.now() - new Date(lead.created_at).getTime()
  const ageDays = ageMs / (24 * 60 * 60 * 1000)
  if (ageDays > 60) {
    score *= 0.5
    factors.push({ factor: `Lead is ${Math.round(ageDays)} days old`, impact: 0.5, direction: 'negative' })
  } else if (ageDays < 7) {
    score *= 1.2
    factors.push({ factor: 'Fresh lead (< 7 days)', impact: 0.2, direction: 'positive' })
  }

  // Clamp to 0-1
  const probability = Math.max(0, Math.min(1, score))

  // Estimate days to close based on similar converted leads
  const similarConverted = allLeads.filter(l =>
    CONVERTED_STATUSES.has(l.status) &&
    l.converted_at &&
    l.ai_qualification === lead.ai_qualification
  )
  const avgDaysToClose = similarConverted.length > 0
    ? Math.round(similarConverted.reduce((sum, l) => {
        const days = (new Date(l.converted_at!).getTime() - new Date(l.created_at).getTime()) / (24 * 60 * 60 * 1000)
        return sum + days
      }, 0) / similarConverted.length)
    : null

  return {
    lead_id: lead.id,
    probability: Math.round(probability * 100) / 100,
    confidence: Math.min(0.9, 0.3 + (factors.length * 0.1)),
    top_factors: factors.sort((a, b) => b.impact - a.impact).slice(0, 5),
    predicted_close_days: avgDaysToClose,
  }
}

// ═══════════════════════════════════════════════════════════════
// OPTIMAL CONTACT WINDOW
// ═══════════════════════════════════════════════════════════════

function computeOptimalContactWindow(messages: MessageRow[]): OptimalContactWindow {
  const inboundMessages = messages.filter(m => m.direction === 'inbound')

  // Response rate by hour
  const byHour: Record<number, { sent: number; replied: number }> = {}
  const byDay: Record<string, { sent: number; replied: number }> = {}
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

  for (let h = 0; h < 24; h++) byHour[h] = { sent: 0, replied: 0 }
  for (const d of days) byDay[d] = { sent: 0, replied: 0 }

  // Count outbound messages by hour/day
  for (const msg of messages) {
    if (msg.direction !== 'outbound') continue
    const dt = new Date(msg.created_at)
    const hour = dt.getHours()
    const day = days[dt.getDay()]
    byHour[hour].sent++
    byDay[day].sent++
  }

  // Count inbound replies by hour/day
  for (const msg of inboundMessages) {
    const dt = new Date(msg.created_at)
    const hour = dt.getHours()
    const day = days[dt.getDay()]
    byHour[hour].replied++
    byDay[day].replied++
  }

  // Compute response rates
  const responseRateByHour: Record<number, number> = {}
  for (let h = 0; h < 24; h++) {
    responseRateByHour[h] = byHour[h].sent > 5
      ? Math.round((byHour[h].replied / byHour[h].sent) * 100)
      : 0
  }

  const responseRateByDay: Record<string, number> = {}
  for (const d of days) {
    responseRateByDay[d] = byDay[d].sent > 5
      ? Math.round((byDay[d].replied / byDay[d].sent) * 100)
      : 0
  }

  // Find best hour and day
  const bestHour = Object.entries(responseRateByHour)
    .sort(([, a], [, b]) => b - a)[0]
  const bestDay = Object.entries(responseRateByDay)
    .sort(([, a], [, b]) => b - a)[0]

  return {
    best_day: bestDay?.[0] || 'Tuesday',
    best_hour: bestHour ? parseInt(bestHour[0]) : 10,
    response_rate_by_hour: responseRateByHour,
    response_rate_by_day: responseRateByDay,
  }
}

// ═══════════════════════════════════════════════════════════════
// NO-SHOW RISK
// ═══════════════════════════════════════════════════════════════

function computeNoShowRisk(leads: LeadRow[], appointments: AppointmentRow[]): NoShowRisk[] {
  const leadMap = new Map(leads.map(l => [l.id, l]))

  return appointments.map(appt => {
    const lead = leadMap.get(appt.lead_id)
    let riskScore = 20 // base risk
    const factors: string[] = []

    if (lead) {
      // Past no-show history (strongest predictor)
      if (lead.no_show_count >= 2) {
        riskScore += 40
        factors.push(`${lead.no_show_count} previous no-shows`)
      } else if (lead.no_show_count === 1) {
        riskScore += 20
        factors.push('1 previous no-show')
      }

      // Low engagement
      if (lead.engagement_score < 20) {
        riskScore += 15
        factors.push('Very low engagement score')
      }

      // No response recently
      if (lead.last_responded_at) {
        const daysSinceResponse = (Date.now() - new Date(lead.last_responded_at).getTime()) / (24 * 60 * 60 * 1000)
        if (daysSinceResponse > 7) {
          riskScore += 15
          factors.push(`No response in ${Math.round(daysSinceResponse)} days`)
        }
      } else if (lead.total_messages_sent > 3) {
        riskScore += 20
        factors.push('Never responded to messages')
      }

      // Low AI score
      if (lead.ai_score < 30 && lead.ai_score > 0) {
        riskScore += 10
        factors.push('Low AI qualification score')
      }
    }

    // Not confirmed
    if (!appt.confirmation_received) {
      riskScore += 10
      factors.push('Appointment not confirmed')
    }

    // Far out appointment (more likely to forget)
    const daysUntil = (new Date(appt.scheduled_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    if (daysUntil > 14) {
      riskScore += 5
      factors.push('Appointment more than 2 weeks out')
    }

    riskScore = Math.min(100, riskScore)

    const riskLevel: NoShowRisk['risk_level'] = riskScore >= 60 ? 'high' : riskScore >= 35 ? 'medium' : 'low'

    return {
      lead_id: appt.lead_id,
      risk_score: riskScore,
      risk_level: riskLevel,
      risk_factors: factors,
    }
  }).sort((a, b) => b.risk_score - a.risk_score)
}

// ═══════════════════════════════════════════════════════════════
// REVENUE PROJECTION
// ═══════════════════════════════════════════════════════════════

function computeRevenueProjection(leads: LeadRow[]): RevenueProjection {
  const activeLeads = leads.filter(l =>
    !['lost', 'disqualified', 'completed'].includes(l.status)
  )

  const hotLeads = activeLeads.filter(l => l.ai_qualification === 'hot')
  const warmLeads = activeLeads.filter(l => l.ai_qualification === 'warm')
  const coldLeads = activeLeads.filter(l => l.ai_qualification === 'cold')

  // Compute historical average deal size
  const completedDeals = leads.filter(l =>
    CONVERTED_STATUSES.has(l.status) && l.treatment_value && l.treatment_value > 0
  )
  const avgDealSize = completedDeals.length > 0
    ? completedDeals.reduce((s, l) => s + (l.treatment_value || 0), 0) / completedDeals.length
    : 25000

  // Compute historical average days to close
  const closedWithDates = leads.filter(l =>
    CONVERTED_STATUSES.has(l.status) && l.converted_at
  )
  const avgDaysToClose = closedWithDates.length > 0
    ? closedWithDates.reduce((sum, l) => {
        return sum + (new Date(l.converted_at!).getTime() - new Date(l.created_at).getTime()) / (24 * 60 * 60 * 1000)
      }, 0) / closedWithDates.length
    : 45

  const hotProjected = Math.round(hotLeads.length * avgDealSize * 0.75)
  const warmProjected = Math.round(warmLeads.length * avgDealSize * 0.35)
  const coldProjected = Math.round(coldLeads.length * avgDealSize * 0.08)

  const currentMonthProjected = hotProjected + warmProjected + coldProjected

  return {
    current_month: currentMonthProjected,
    next_month: Math.round(currentMonthProjected * 0.85), // slight decay
    three_month: Math.round(currentMonthProjected * 2.3),  // pipeline growth assumption
    by_tier: {
      hot: { count: hotLeads.length, projected: hotProjected, probability: 0.75 },
      warm: { count: warmLeads.length, projected: warmProjected, probability: 0.35 },
      cold: { count: coldLeads.length, projected: coldProjected, probability: 0.08 },
    },
    avg_deal_size: Math.round(avgDealSize),
    avg_days_to_close: Math.round(avgDaysToClose),
  }
}

// ═══════════════════════════════════════════════════════════════
// LEAD VELOCITY
// ═══════════════════════════════════════════════════════════════

function computeLeadVelocity(leads: LeadRow[]): LeadVelocity {
  const now = Date.now()
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000

  const currentWeekLeads = leads.filter(l => now - new Date(l.created_at).getTime() < oneWeekMs)
  const previousWeekLeads = leads.filter(l => {
    const age = now - new Date(l.created_at).getTime()
    return age >= oneWeekMs && age < 2 * oneWeekMs
  })

  const currentWeek = currentWeekLeads.length
  const previousWeek = previousWeekLeads.length
  const changePct = previousWeek > 0 ? ((currentWeek - previousWeek) / previousWeek) * 100 : 0

  const qualifiedThisWeek = currentWeekLeads.filter(l =>
    ['qualified', 'consultation_scheduled', 'consultation_completed'].includes(l.status)
  ).length

  const convertedThisWeek = currentWeekLeads.filter(l =>
    CONVERTED_STATUSES.has(l.status)
  ).length

  return {
    current_week: currentWeek,
    previous_week: previousWeek,
    change_pct: Math.round(changePct),
    trend: changePct > 10 ? 'accelerating' : changePct < -10 ? 'decelerating' : 'stable',
    qualified_velocity: qualifiedThisWeek,
    conversion_velocity: convertedThisWeek,
  }
}
