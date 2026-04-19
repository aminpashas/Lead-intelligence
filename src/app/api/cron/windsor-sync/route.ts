/**
 * Windsor.ai daily ad spend sync.
 * Vercel cron: 05:00 UTC daily — after CareStack sync (04:30) so revenue + spend
 * land in the same business day for analytics.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { getWindsorConfig } from '@/lib/connectors/windsor/client'
import { runWindsorSync } from '@/lib/connectors/windsor/sync'

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()

  const { data: orgs } = await supabase
    .from('connector_configs')
    .select('organization_id')
    .eq('connector_type', 'windsor')
    .eq('enabled', true)

  if (!orgs || orgs.length === 0) {
    return NextResponse.json({ message: 'No Windsor connectors configured', orgs: 0 })
  }

  const results: Array<{ organization_id: string; runs: unknown[] }> = []

  for (const org of orgs as Array<{ organization_id: string }>) {
    const config = await getWindsorConfig(supabase, org.organization_id)
    if (!config) {
      results.push({ organization_id: org.organization_id, runs: [{ error: 'config_invalid' }] })
      continue
    }
    const runs = await runWindsorSync(supabase, org.organization_id, config)
    results.push({ organization_id: org.organization_id, runs })
  }

  return NextResponse.json({ orgs: results.length, results })
}

export const GET = POST
