/**
 * Bridge to Dion Growth Studio (the marketing-intelligence sibling app).
 *
 * Lets the CRM read marketing performance back — spend, ROAS, GA4 sessions,
 * GMB — so leads/revenue can be shown against the spend that produced them.
 * Mirror of dion-growth-studio's lead-intelligence bridge. Returns null if
 * the bridge isn't configured or is unreachable, so callers degrade cleanly.
 *
 * Env (Vercel only):
 *   GROWTH_STUDIO_BASE_URL — e.g. https://dion-growth-studio.vercel.app
 *   GROWTH_STUDIO_API_KEY  — equals dion-growth-studio's LEAD_INTELLIGENCE_SERVICE_KEY
 */

export interface PaidRollup {
  spend: number
  clicks: number
  impressions: number
  conversions: number
  conversion_value: number
  roas: number | null
  cpa: number | null
}

export interface GrowthStudioBrandPerformance {
  slug: string
  name: string
  domain: string | null
  paid: PaidRollup
  organic: { sessions: number; users: number; conversions: number; engagementRate: number; lastDate: string | null }
  gmb: { views: number; calls: number; website_clicks: number; directions: number }
  top_queries: { query: string; clicks: number; position: number }[]
}

export interface GrowthStudioPerformance {
  customer_id: string
  workspace: { id: string; slug: string; name: string }
  window_days: number
  generated_at: string
  totals: {
    paid: PaidRollup
    organic: { sessions: number; users: number; conversions: number }
    gmb: { views: number; calls: number; website_clicks: number; directions: number }
  }
  brands: GrowthStudioBrandPerformance[]
}

function getBase(): string | null {
  return process.env.GROWTH_STUDIO_BASE_URL ?? null
}
function getKey(): string | null {
  return process.env.GROWTH_STUDIO_API_KEY ?? null
}

/**
 * Read marketing performance for a customer (organization_id), keyed on the
 * Growth Studio side by workspaces.lead_intel_customer_id. Returns null if the
 * bridge isn't configured, the customer isn't linked, or the call fails.
 */
export async function getMarketingPerformance(params: {
  customerId: string
  days?: number
}): Promise<GrowthStudioPerformance | null> {
  const base = getBase()
  const key = getKey()
  if (!base || !key) return null
  try {
    const res = await fetch(
      `${base}/api/v1/performance?customer_id=${encodeURIComponent(params.customerId)}&days=${params.days ?? 30}`,
      {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) return null
    return (await res.json()) as GrowthStudioPerformance
  } catch {
    return null
  }
}
