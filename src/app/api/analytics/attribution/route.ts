import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'

/**
 * GET /api/analytics/attribution — Full marketing attribution analytics
 *
 * Breaks down lead performance by UTM source, medium, campaign, content, and term.
 * Shows cost-per-lead proxies, conversion rates, and revenue per source.
 */
export async function GET(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const orgId = profile.organization_id

  // Date range (default 90 days for attribution)
  const startParam = request.nextUrl.searchParams.get('start_date')
  const endParam = request.nextUrl.searchParams.get('end_date')
  const startDate = startParam
    ? new Date(startParam).toISOString()
    : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
  const endDate = endParam
    ? new Date(endParam).toISOString()
    : new Date().toISOString()

  // Fetch all leads in date range with attribution fields
  const { data: leads, error } = await supabase
    .from('leads')
    .select(`
      id, source_type, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
      gclid, fbclid, landing_page_url,
      status, ai_qualification, ai_score,
      treatment_value, actual_revenue,
      created_at, converted_at,
      consultation_date, no_show_count
    `)
    .eq('organization_id', orgId)
    .gte('created_at', startDate)
    .lte('created_at', endDate)
    .limit(10000)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const allLeads = leads || []
  const CONVERTED_STATUSES = ['contract_signed', 'scheduled', 'in_treatment', 'completed']

  // ── 1. Attribution by Source ──
  const bySource = aggregateBy(allLeads, 'source_type', CONVERTED_STATUSES)

  // ── 2. Attribution by UTM Source (ad platform) ──
  const byUtmSource = aggregateBy(allLeads, 'utm_source', CONVERTED_STATUSES)

  // ── 3. Attribution by UTM Medium ──
  const byUtmMedium = aggregateBy(allLeads, 'utm_medium', CONVERTED_STATUSES)

  // ── 4. Attribution by Campaign ──
  const byCampaign = aggregateBy(allLeads, 'utm_campaign', CONVERTED_STATUSES)

  // ── 5. Attribution by Keyword (utm_term) ──
  const byKeyword = aggregateBy(allLeads, 'utm_term', CONVERTED_STATUSES)

  // ── 6. Attribution by Landing Page ──
  const byLandingPage = aggregateBy(
    allLeads.map(l => ({
      ...l,
      landing_page_clean: cleanLandingPage(l.landing_page_url),
    })),
    'landing_page_clean',
    CONVERTED_STATUSES
  )

  // ── 7. Click ID Attribution (Google vs Meta) ──
  const googleAdsLeads = allLeads.filter(l => l.gclid)
  const metaAdsLeads = allLeads.filter(l => l.fbclid)
  const organicLeads = allLeads.filter(l => !l.gclid && !l.fbclid)

  const clickAttribution = [
    buildClickGroup('Google Ads (gclid)', googleAdsLeads, CONVERTED_STATUSES),
    buildClickGroup('Meta Ads (fbclid)', metaAdsLeads, CONVERTED_STATUSES),
    buildClickGroup('Organic / Direct', organicLeads, CONVERTED_STATUSES),
  ].filter(g => g.leads > 0)

  // ── 8. Funnel by Source (multi-step conversion) ──
  const funnelBySource = buildFunnelBySource(allLeads, CONVERTED_STATUSES)

  // ── 9. Time-to-Convert by Source ──
  const timeToConvert = buildTimeToConvert(allLeads, CONVERTED_STATUSES)

  // ── 10. KPIs ──
  const totalLeads = allLeads.length
  const convertedLeads = allLeads.filter(l => CONVERTED_STATUSES.includes(l.status)).length
  const totalRevenue = allLeads.reduce((s, l) => s + (l.actual_revenue || l.treatment_value || 0), 0)
  const avgDealSize = convertedLeads > 0 ? totalRevenue / convertedLeads : 0
  const paidLeads = allLeads.filter(l => l.gclid || l.fbclid || ['google_ads', 'meta_ads'].includes(l.source_type)).length
  const paidConversions = allLeads.filter(l =>
    CONVERTED_STATUSES.includes(l.status) &&
    (l.gclid || l.fbclid || ['google_ads', 'meta_ads'].includes(l.source_type))
  ).length

  return NextResponse.json({
    kpis: {
      totalLeads,
      convertedLeads,
      conversionRate: totalLeads > 0 ? Math.round(convertedLeads / totalLeads * 1000) / 10 : 0,
      totalRevenue: Math.round(totalRevenue),
      avgDealSize: Math.round(avgDealSize),
      paidLeads,
      paidConversions,
      paidConversionRate: paidLeads > 0 ? Math.round(paidConversions / paidLeads * 1000) / 10 : 0,
    },
    bySource,
    byUtmSource,
    byUtmMedium,
    byCampaign,
    byKeyword,
    byLandingPage,
    clickAttribution,
    funnelBySource,
    timeToConvert,
    dateRange: { start: startDate, end: endDate },
  })
}

// ── Helpers ──

type LeadRow = Record<string, any>

type AttributionRow = {
  dimension: string
  leads: number
  conversions: number
  conversionRate: number
  revenue: number
  avgDealSize: number
  hotLeads: number
  avgScore: number
  consultations: number
  noShows: number
}

function aggregateBy(
  leads: LeadRow[],
  field: string,
  convertedStatuses: string[]
): AttributionRow[] {
  const groups: Record<string, LeadRow[]> = {}
  for (const lead of leads) {
    const key = lead[field] || '(none)'
    if (!groups[key]) groups[key] = []
    groups[key].push(lead)
  }

  return Object.entries(groups)
    .map(([dimension, groupLeads]) => {
      const conversions = groupLeads.filter(l => convertedStatuses.includes(l.status)).length
      const revenue = groupLeads.reduce((s, l) => s + (l.actual_revenue || l.treatment_value || 0), 0)
      const scores = groupLeads.filter(l => l.ai_score).map(l => l.ai_score)
      return {
        dimension,
        leads: groupLeads.length,
        conversions,
        conversionRate: groupLeads.length > 0 ? Math.round(conversions / groupLeads.length * 1000) / 10 : 0,
        revenue: Math.round(revenue),
        avgDealSize: conversions > 0 ? Math.round(revenue / conversions) : 0,
        hotLeads: groupLeads.filter(l => l.ai_qualification === 'hot').length,
        avgScore: scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
        consultations: groupLeads.filter(l => l.consultation_date).length,
        noShows: groupLeads.filter(l => (l.no_show_count || 0) > 0).length,
      }
    })
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 20)
}

function buildClickGroup(
  name: string,
  leads: LeadRow[],
  convertedStatuses: string[]
): { name: string; leads: number; conversions: number; conversionRate: number; revenue: number } {
  const conversions = leads.filter(l => convertedStatuses.includes(l.status)).length
  const revenue = leads.reduce((s, l) => s + (l.actual_revenue || l.treatment_value || 0), 0)
  return {
    name,
    leads: leads.length,
    conversions,
    conversionRate: leads.length > 0 ? Math.round(conversions / leads.length * 1000) / 10 : 0,
    revenue: Math.round(revenue),
  }
}

function cleanLandingPage(url: string | null): string {
  if (!url) return '(none)'
  try {
    const u = new URL(url)
    return u.pathname || '/'
  } catch {
    return url.split('?')[0] || '(none)'
  }
}

function buildFunnelBySource(
  leads: LeadRow[],
  convertedStatuses: string[]
): Array<{ source: string; total: number; qualified: number; consulted: number; converted: number }> {
  const groups: Record<string, LeadRow[]> = {}
  for (const lead of leads) {
    const key = lead.source_type || '(none)'
    if (!groups[key]) groups[key] = []
    groups[key].push(lead)
  }

  return Object.entries(groups)
    .map(([source, groupLeads]) => ({
      source,
      total: groupLeads.length,
      qualified: groupLeads.filter(l => l.ai_qualification === 'hot' || l.ai_qualification === 'warm').length,
      consulted: groupLeads.filter(l => l.consultation_date).length,
      converted: groupLeads.filter(l => convertedStatuses.includes(l.status)).length,
    }))
    .filter(g => g.total >= 2)
    .sort((a, b) => b.total - a.total)
    .slice(0, 10)
}

function buildTimeToConvert(
  leads: LeadRow[],
  convertedStatuses: string[]
): Array<{ source: string; avgDays: number; medianDays: number; count: number }> {
  const groups: Record<string, number[]> = {}
  for (const lead of leads) {
    if (convertedStatuses.includes(lead.status) && lead.converted_at && lead.created_at) {
      const key = lead.source_type || '(none)'
      if (!groups[key]) groups[key] = []
      const days = (new Date(lead.converted_at).getTime() - new Date(lead.created_at).getTime()) / (1000 * 60 * 60 * 24)
      if (days >= 0) groups[key].push(days)
    }
  }

  return Object.entries(groups)
    .map(([source, days]) => {
      days.sort((a, b) => a - b)
      return {
        source,
        avgDays: Math.round(days.reduce((a, b) => a + b, 0) / days.length * 10) / 10,
        medianDays: Math.round(days[Math.floor(days.length / 2)] * 10) / 10,
        count: days.length,
      }
    })
    .filter(g => g.count >= 1)
    .sort((a, b) => a.avgDays - b.avgDays)
}
