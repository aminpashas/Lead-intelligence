import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'

const saveConversationSchema = z.object({
  title: z.string().min(1).max(200),
  mode: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string(),
      timestamp: z.string(),
    })
  ),
  system_prompt_snapshot: z.string().nullable().optional(),
})

export async function GET() {
  const supabase = await createClient()
  const { data: profile } = await supabase.from('user_profiles').select('organization_id').single()
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('ai_test_conversations')
    .select('*')
    .eq('organization_id', profile.organization_id)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ conversations: data })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: profile } = await supabase.from('user_profiles').select('id, organization_id').single()
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const parsed = saveConversationSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('ai_test_conversations')
    .insert({
      organization_id: profile.organization_id,
      created_by: profile.id,
      ...parsed.data,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ conversation: data }, { status: 201 })
}
