import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { processTriggerCampaigns, detectColdLeads } from '@/lib/campaigns/triggers'
import { logger } from '@/lib/logger'

// POST /api/cron/triggers — Check for trigger events (every 5 minutes)
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.WEBHOOK_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  const supabase = createServiceClient()

  const { data: orgs } = await supabase.from('organizations').select('id')
  if (!orgs || orgs.length === 0) {
    return NextResponse.json({ message: 'No organizations', triggered: 0 })
  }

  let totalTriggered = 0
  const errors: string[] = []

  for (const org of orgs) {
    try {
      // Detect cold leads and trigger campaigns
      const coldEvents = await detectColdLeads(supabase, org.id, 7)
      for (const event of coldEvents) {
        try {
          const enrolled = await processTriggerCampaigns(supabase, event)
          totalTriggered += enrolled
        } catch (err) {
          errors.push(`Cold lead trigger (${event.lead_id}): ${err instanceof Error ? err.message : 'unknown'}`)
        }
      }
    } catch (err) {
      errors.push(`Trigger error (org ${org.id}): ${err instanceof Error ? err.message : 'unknown'}`)
    }
  }

  const duration = Date.now() - startTime
  const summary = {
    success: true,
    triggered: totalTriggered,
    errors: errors.length > 0 ? errors : undefined,
    durationMs: duration,
    timestamp: new Date().toISOString(),
  }

  logger.info('Trigger cron completed', summary)

  return NextResponse.json(summary)
}

export async function GET(request: NextRequest) {
  return POST(request)
}
