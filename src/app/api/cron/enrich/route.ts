import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { enrichLead } from '@/lib/enrichment'

const MAX_LEADS_PER_RUN = 50
const MAX_LEADS_PER_ORG = 10

// POST /api/cron/enrich — Background enrichment for leads missing enrichment data
// Called every 15 minutes by Vercel Cron or external scheduler
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.WEBHOOK_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()

  const { data: orgs } = await supabase
    .from('organizations')
    .select('id')

  if (!orgs || orgs.length === 0) {
    return NextResponse.json({ message: 'No organizations', enriched: 0 })
  }

  let totalEnriched = 0
  let totalFailed = 0
  const errors: string[] = []

  for (const org of orgs) {
    if (totalEnriched >= MAX_LEADS_PER_RUN) break

    // Find leads that need enrichment: have email or phone, status is pending/partial
    const { data: leads } = await supabase
      .from('leads')
      .select('*')
      .eq('organization_id', org.id)
      .in('enrichment_status', ['pending', 'partial'])
      .or('email.not.is.null,phone.not.is.null')
      .order('created_at', { ascending: false })
      .limit(Math.min(MAX_LEADS_PER_ORG, MAX_LEADS_PER_RUN - totalEnriched))

    if (!leads || leads.length === 0) continue

    for (const lead of leads) {
      try {
        await enrichLead(supabase, lead)
        totalEnriched++
      } catch (err) {
        totalFailed++
        errors.push(`Lead ${lead.id}: ${err instanceof Error ? err.message : 'Unknown error'}`)

        // Mark as failed so we don't retry endlessly
        await supabase
          .from('leads')
          .update({ enrichment_status: 'failed' })
          .eq('id', lead.id)
      }
    }
  }

  return NextResponse.json({
    enriched: totalEnriched,
    failed: totalFailed,
    errors: errors.slice(0, 10),
  })
}

// GET handler for Vercel Cron compatibility
export async function GET(request: NextRequest) {
  return POST(request)
}
