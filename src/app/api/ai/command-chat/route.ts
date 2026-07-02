import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { runCommandAgent } from '@/lib/ai/command-agent'

/**
 * POST /api/ai/command-chat
 *
 * The dashboard command-center chat. Runs the command agent (tool-use loop over
 * live CRM data) and returns its reply plus any proposed bulk actions. Proposals
 * are executed by the CLIENT posting to /api/sms/mass or /api/email/mass after
 * the user confirms — this route never sends anything.
 *
 * Body: { messages: [{ role: 'user' | 'assistant', content: string }] }
 */

const chatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(4000),
      })
    )
    .min(1)
    .max(40),
})

export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.ai)
  if (rlError) return rlError

  try {
    const supabase = await createClient()
    const { orgId } = await resolveActiveOrg(supabase)
    if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('full_name')
      .single()

    const parsed = chatSchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const result = await runCommandAgent({
      supabase,
      orgId,
      userName: profile?.full_name?.split(' ')[0],
      history: parsed.data.messages,
    })

    return NextResponse.json(result)
  } catch (err) {
    console.error('[command-chat] agent error:', err)
    return NextResponse.json({ error: 'Agent failed — try again' }, { status: 500 })
  }
}
