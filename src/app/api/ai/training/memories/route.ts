import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'

const createMemorySchema = z.object({
  title: z.string().min(1).max(200),
  category: z.enum(['tone_and_style', 'product_knowledge', 'objection_handling', 'pricing_rules', 'compliance_rules', 'general']),
  content: z.string().min(1).max(10000),
  is_enabled: z.boolean().optional().default(true),
  priority: z.number().int().min(0).max(100).optional().default(0),
})

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: profile } = await supabase.from('user_profiles').select('organization_id').single()
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const category = request.nextUrl.searchParams.get('category')

  let query = supabase
    .from('ai_memories')
    .select('*')
    .eq('organization_id', profile.organization_id)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: false })

  if (category) {
    query = query.eq('category', category)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ memories: data })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: profile } = await supabase.from('user_profiles').select('id, organization_id').single()
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const parsed = createMemorySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('ai_memories')
    .insert({
      organization_id: profile.organization_id,
      created_by: profile.id,
      ...parsed.data,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ memory: data }, { status: 201 })
}
