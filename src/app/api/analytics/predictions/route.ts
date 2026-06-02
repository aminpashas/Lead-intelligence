/**
 * GET /api/analytics/predictions — Predictive Analytics
 *
 * Returns AI-powered predictions including conversion probabilities,
 * revenue projections, no-show risk, and optimal contact windows.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generatePredictiveInsights } from '@/lib/ai/predictive'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'

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

  try {
    const insights = await generatePredictiveInsights(supabase, profile.organization_id)
    return NextResponse.json(insights)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[predictions] Failed to generate insights:', message)
    return NextResponse.json({ error: 'Failed to generate predictions' }, { status: 500 })
  }
}
