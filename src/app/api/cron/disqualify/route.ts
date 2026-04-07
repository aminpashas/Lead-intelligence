import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { runDisqualificationRules } from '@/lib/ai/disqualification'

// POST /api/cron/disqualify - Run auto-disqualification rules
// Called by Vercel Cron or external scheduler daily
export async function POST(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.WEBHOOK_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()

  // Get all active organizations
  const { data: orgs } = await supabase
    .from('organizations')
    .select('id')
    .eq('subscription_status', 'active')

  if (!orgs || orgs.length === 0) {
    return NextResponse.json({ message: 'No active organizations' })
  }

  const results = []
  for (const org of orgs) {
    const result = await runDisqualificationRules(org.id)
    results.push({ organization_id: org.id, ...result })
  }

  return NextResponse.json({ results })
}
