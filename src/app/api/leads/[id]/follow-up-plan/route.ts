import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { generateTailoredFollowUp } from '@/lib/ai/patient-psychology'
import { computeFollowUpTiming } from '@/lib/followup/timing'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'

const bodySchema = z.object({
  channel: z.enum(['sms', 'email', 'call']).optional(),
  context: z.string().max(500).optional(),
})

/**
 * POST /api/leads/[id]/follow-up-plan
 *
 * Generates a tailored, ready-to-send follow-up plan (channel, timing, opening
 * message, talking points) via the existing patient-psychology engine. Requires
 * a psychology profile — run /api/ai/analyze first. Draft only; nothing is sent.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rlError = applyRateLimit(request, RATE_LIMITS.ai)
  if (rlError) return rlError

  const { id } = await params
  const supabase = await createClient()

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const { data: lead } = await supabase
    .from('leads')
    .select('*')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()
  if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })

  const { data: profile } = await supabase
    .from('patient_profiles')
    .select('*')
    .eq('lead_id', id)
    .maybeSingle()
  if (!profile) {
    return NextResponse.json(
      { error: 'No psychology profile yet — run AI analysis first' },
      { status: 409 }
    )
  }

  const { data: messages } = await supabase
    .from('messages')
    .select('direction, body, sender_type, created_at')
    .eq('lead_id', id)
    .eq('organization_id', orgId)
    .order('created_at', { ascending: true })
    .limit(10)

  const timing = computeFollowUpTiming(lead, Date.now())
  const channel = parsed.data.channel ?? timing.suggestedChannel

  try {
    const plan = await generateTailoredFollowUp(supabase, {
      organization_id: orgId,
      lead_id: id,
      lead,
      profile,
      recentMessages: messages || [],
      channel,
      context: parsed.data.context,
    })
    return NextResponse.json({ plan, timing })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to generate follow-up plan' },
      { status: 500 }
    )
  }
}
