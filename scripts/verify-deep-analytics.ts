/**
 * Temporary verification: exercises the same RPC fan-out as
 * /api/analytics/deep and runs the recommendations engine on LIVE data.
 *   npx tsx scripts/verify-deep-analytics.ts
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
import { buildRecommendations } from '../src/lib/analytics/recommendations'

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const orgId = 'fa64e53c-3d9b-493e-b904-59580cb3f29c'
const args = {
  p_org_id: orgId,
  p_start: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
  p_end: new Date().toISOString(),
}

async function main() {
  const names = [
    'get_quality_tiers', 'get_channel_scorecard', 'get_campaign_scorecard',
    'get_unattributed_spend', 'get_speed_to_lead', 'get_engagement_funnel',
    'get_contact_heatmap', 'get_conversion_lag', 'get_action_queue',
    'get_tracking_coverage', 'get_intent_objections',
  ] as const
  const results: Record<string, unknown> = {}
  for (const n of names) {
    const a = n === 'get_action_queue' ? { p_org_id: orgId } : args
    const t0 = Date.now()
    const { data, error } = await supabase.rpc(n, a)
    if (error) throw new Error(`${n}: ${error.message}`)
    results[n] = data
    console.log(`ok ${n} (${Date.now() - t0}ms)`)
  }

  const recs = buildRecommendations({
    channels: results.get_channel_scorecard as never,
    campaigns: results.get_campaign_scorecard as never,
    unattributedSpend: results.get_unattributed_spend as never,
    speedToLead: results.get_speed_to_lead as never,
    engagement: results.get_engagement_funnel as never,
    actionQueue: results.get_action_queue as never,
    tracking: results.get_tracking_coverage as never,
  })
  console.log(`\n${recs.length} recommendations on live data:`)
  for (const r of recs) {
    console.log(`  [${r.severity.toUpperCase()}] (${r.category}${r.dgsRelevant ? ', DGS' : ''}) ${r.title}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
