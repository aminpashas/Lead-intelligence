import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { isAdminRole } from '@/lib/auth/permissions'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { serviceLineSlugSchema } from '@/lib/validators/practice-profile'
import { getOrCreatePracticeProfile } from '@/lib/campaigns/practice-profile'
import { runOnboardingInterview } from '@/lib/ai/onboarding-agent'

/**
 * POST /api/campaigns/onboarding/chat
 *
 * One turn of the campaign-onboarding interview. The agent records answers
 * into practice_profiles via a schema-validated tool; launch readiness is
 * computed by code and returned as `gaps` — this route never creates or
 * activates campaigns (that's /api/campaigns/onboarding/launch, admin-only).
 *
 * Access: admins (incl. agency admins in a client account) always; other
 * practice staff only while the agency has self-serve enabled for the org.
 *
 * Body: { service_line, messages: [{ role, content }] }
 */

const chatSchema = z.object({
  service_line: serviceLineSlugSchema,
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(4000),
      })
    )
    .min(1)
    .max(60),
})

export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.ai)
  if (rlError) return rlError

  try {
    const supabase = await createClient()
    const { orgId, role } = await resolveActiveOrg(supabase)
    if (!orgId || !role) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const parsed = chatSchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const profile = await getOrCreatePracticeProfile(supabase, orgId)
    if (!profile) {
      return NextResponse.json({ error: 'Could not load practice profile' }, { status: 500 })
    }

    if (!isAdminRole(role) && !profile.self_serve_enabled) {
      return NextResponse.json(
        { error: 'Campaign onboarding is managed by your agency for this practice' },
        { status: 403 }
      )
    }

    const [{ data: userProfile }, { data: org }] = await Promise.all([
      getOwnProfile(supabase, 'full_name'),
      supabase.from('organizations').select('name').eq('id', orgId).maybeSingle<{ name: string }>(),
    ])

    const result = await runOnboardingInterview({
      supabase,
      orgId,
      practiceName: org?.name ?? 'the practice',
      serviceLine: parsed.data.service_line,
      history: parsed.data.messages,
      profile,
      userName: userProfile?.full_name?.split(' ')[0],
    })

    return NextResponse.json({
      reply: result.reply,
      gaps: result.gaps,
      completeness: result.completeness,
    })
  } catch (err) {
    console.error('[onboarding-chat] agent error:', err)
    return NextResponse.json({ error: 'Interview failed — try again' }, { status: 500 })
  }
}
