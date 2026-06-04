import { withCron } from '@/lib/cron/with-cron'
import { runDisqualificationRules } from '@/lib/ai/disqualification'

// POST /api/cron/disqualify - Run auto-disqualification rules
// Called by Vercel Cron daily (vercel.json). Heartbeats to cron_runs via withCron.
export const POST = withCron('disqualify', async ({ supabase }) => {
  const { data: orgs } = await supabase
    .from('organizations')
    .select('id')
    .eq('subscription_status', 'active')

  if (!orgs || orgs.length === 0) {
    return { status: 'skipped', items: 0, data: { message: 'No active organizations' } }
  }

  const results = []
  for (const org of orgs) {
    const result = await runDisqualificationRules(org.id)
    results.push({ organization_id: org.id, ...result })
  }

  return { items: results.length, data: { results } }
})

export const GET = POST
