import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'
import Anthropic from '@anthropic-ai/sdk'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import {
  getActiveMemories,
  getRelevantKnowledge,
  buildTrainingSystemPrompt,
  PLAYGROUND_MODES,
  type PlaygroundMode,
} from '@/lib/ai/training-context'

function getAnthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
}

const chatSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().min(1),
    })
  ).min(1),
  mode: z.string().default('general'),
})

export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.ai)
  if (rlError) return rlError

  const supabase = await createClient()
  const { data: profile } = await supabase.from('user_profiles').select('organization_id').single()
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const parsed = chatSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const { messages, mode } = parsed.data
  const modeConfig = PLAYGROUND_MODES[mode as PlaygroundMode] || PLAYGROUND_MODES.general
  const lastUserMessage = messages.filter((m) => m.role === 'user').pop()?.content || ''

  try {
    // Fetch training context
    const [memories, articles] = await Promise.all([
      getActiveMemories(supabase, profile.organization_id),
      getRelevantKnowledge(supabase, profile.organization_id, lastUserMessage),
    ])

    // Build composite system prompt
    const systemPrompt = buildTrainingSystemPrompt(modeConfig.prompt, memories, articles)

    // Call Claude
    const anthropic = getAnthropic()
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: systemPrompt,
      messages: messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    })

    const assistantMessage =
      response.content[0].type === 'text' ? response.content[0].text : ''

    return NextResponse.json({
      response: assistantMessage,
      system_prompt_used: systemPrompt,
      memories_used: memories.map((m) => m.title),
      articles_used: articles.map((a) => ({ id: a.id, title: a.title })),
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'AI chat failed'
    console.error('AI Training Chat error:', err)
    return NextResponse.json({ error: errorMsg }, { status: 500 })
  }
}
