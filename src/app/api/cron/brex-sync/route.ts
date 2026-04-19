/**
 * Brex daily expense sync.
 * Vercel cron: 06:00 UTC daily (after Windsor at 05:00).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { getBrexConfig, runBrexSync } from '@/lib/connectors/brex/client'

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()

  const { data: orgs } = await supabase
    .from('connector_configs')
    .select('organization_id')
    .eq('connector_type', 'brex')
    .eq('enabled', true)

  if (!orgs || orgs.length === 0) {
    return NextResponse.json({ message: 'No Brex connectors configured', orgs: 0 })
  }

  const results: Array<{ organization_id: string; result: unknown }> = []

  for (const org of orgs as Array<{ organization_id: string }>) {
    const config = await getBrexConfig(supabase, org.organization_id)
    if (!config) {
      results.push({ organization_id: org.organization_id, result: { error: 'config_invalid' } })
      continue
    }
    const result = await runBrexSync(supabase, org.organization_id, config)
    results.push({ organization_id: org.organization_id, result })
  }

  return NextResponse.json({ orgs: results.length, results })
}

export const GET = POST
