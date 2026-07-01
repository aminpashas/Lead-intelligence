import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { classifyFeedback } from '@/lib/feedback/review-gating'
import { postSlack } from '@/lib/alerts/slack'
import { applyDistributedRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { z } from 'zod'

const schema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(2000).optional(),
})

// POST /api/feedback/[token] — public; guarded by the unguessable token, not auth.
// The 144-bit token is the only guard: we look up exactly the row matching it and
// never return (or act on) any other org's data. Distributed rate limiting adds
// defense-in-depth against token brute-forcing (same pattern as the public booking route).
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const rlError = await applyDistributedRateLimit(request, RATE_LIMITS.publicForm, 'feedback')
  if (rlError) return rlError

  const { token } = await params
  const parsed = schema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 })

  const supabase = createServiceClient()
  const { data: fb } = await supabase
    .from('patient_feedback')
    .select('id, organization_id, lead_id, status')
    .eq('token', token)
    .maybeSingle()
  if (!fb) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // Idempotent: a re-submit on an already-responded (or opted-out/bounced) token
  // is a no-op — no re-insert, no re-notify, no rating overwrite.
  if (fb.status !== 'requested') return NextResponse.json({ alreadyResponded: true })

  const { data: settings } = await supabase
    .from('booking_settings')
    .select('google_review_url, feedback_promoter_threshold')
    .eq('organization_id', fb.organization_id)
    .maybeSingle()
  const threshold = settings?.feedback_promoter_threshold ?? 4

  const { sentiment, routedToReview } = classifyFeedback(parsed.data.rating, threshold)

  await supabase.from('patient_feedback').update({
    status: 'responded', responded_at: new Date().toISOString(),
    rating: parsed.data.rating, comment: parsed.data.comment ?? null,
    sentiment, routed_to_review: routedToReview,
  }).eq('id', fb.id)

  await supabase.from('lead_activities').insert({
    organization_id: fb.organization_id, lead_id: fb.lead_id,
    activity_type: 'patient_feedback_received',
    title: `Patient rated their visit ${parsed.data.rating}★`,
    description: parsed.data.comment ?? null,
    metadata: { rating: parsed.data.rating, sentiment, routed_to_review: routedToReview },
  })

  if (!routedToReview) {
    // Detractor: alert staff for service recovery; never route to public review.
    await postSlack(`⚠️ Patient rated a consult ${parsed.data.rating}★${parsed.data.comment ? `: "${parsed.data.comment}"` : ''} — follow up for service recovery.`)
    return NextResponse.json({ ok: true, routedToReview: false })
  }
  return NextResponse.json({ ok: true, routedToReview: true, reviewUrl: settings?.google_review_url ?? null })
}
