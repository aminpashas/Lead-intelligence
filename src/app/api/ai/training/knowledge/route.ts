import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'

const createArticleSchema = z.object({
  title: z.string().min(1).max(200),
  category: z.enum(['procedures', 'pricing', 'faqs', 'aftercare', 'financing', 'general']),
  content: z.string().min(1).max(50000),
  tags: z.array(z.string().max(50)).max(20).optional().default([]),
  is_enabled: z.boolean().optional().default(true),
})

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: profile } = await supabase.from('user_profiles').select('organization_id').single()
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const category = request.nextUrl.searchParams.get('category')
  const search = request.nextUrl.searchParams.get('search')
  const tag = request.nextUrl.searchParams.get('tag')

  let query = supabase
    .from('ai_knowledge_articles')
    .select('*')
    .eq('organization_id', profile.organization_id)
    .order('created_at', { ascending: false })

  if (category) query = query.eq('category', category)
  if (tag) query = query.contains('tags', [tag])
  if (search) query = query.textSearch('title', search, { type: 'websearch' })

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ articles: data })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: profile } = await supabase.from('user_profiles').select('id, organization_id').single()
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const parsed = createArticleSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('ai_knowledge_articles')
    .insert({
      organization_id: profile.organization_id,
      created_by: profile.id,
      ...parsed.data,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ article: data }, { status: 201 })
}
