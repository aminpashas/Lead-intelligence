import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'

// GET /api/agents/[id]/reviews?limit=20&before=ISO
//
// Paginated review history (newest first). RLS enforces org isolation;
// unauthorized agents return empty array.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const { id: agentId } = await params
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const limitParam = Number(request.nextUrl.searchParams.get('limit') ?? '20')
  const limit = Math.min(Math.max(limitParam, 1), 100)
  const before = request.nextUrl.searchParams.get('before')

  let query = supabase
    .from('agent_performance_reviews')
    .select('id, period_start, period_end, overall_grade, reasons, notes, reviewed_by, reviewed_at, acknowledged_by, acknowledged_at')
    .eq('agent_id', agentId)
    .order('period_end', { ascending: false })
    .limit(limit)

  if (before) {
    query = query.lt('period_end', before)
  }

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ reviews: data ?? [] })
}
