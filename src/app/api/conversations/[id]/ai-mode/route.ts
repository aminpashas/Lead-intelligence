import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'

const aiModeSchema = z.object({
  ai_mode: z.enum(['auto', 'assist', 'off']),
})

/**
 * PATCH /api/conversations/[id]/ai-mode — Toggle AI mode for a conversation
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const { id } = await params
  const supabase = await createClient()

  // Auth
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Safe JSON parsing
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = aiModeSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid AI mode', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { ai_mode } = parsed.data

  // Verify conversation belongs to user's org
  const { data: conversation } = await supabase
    .from('conversations')
    .select('id, lead_id, ai_mode')
    .eq('id', id)
    .eq('organization_id', profile.organization_id)
    .single()

  if (!conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  // Update AI mode
  const { error } = await supabase
    .from('conversations')
    .update({
      ai_mode,
      ai_enabled: ai_mode !== 'off',
    })
    .eq('id', id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Log activity on the lead
  const modeLabels = { auto: 'Auto (autonomous)', assist: 'Assist (draft only)', off: 'Off (human only)' }
  await supabase.from('lead_activities').insert({
    organization_id: profile.organization_id,
    lead_id: conversation.lead_id,
    activity_type: 'ai_mode_changed',
    title: `AI mode changed to ${modeLabels[ai_mode]}`,
    metadata: {
      conversation_id: id,
      previous_mode: conversation.ai_mode,
      new_mode: ai_mode,
    },
  })

  return NextResponse.json({ ok: true, ai_mode, ai_enabled: ai_mode !== 'off' })
}
