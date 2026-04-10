import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { FAQ_SEED_DATA } from '@/lib/ai/faq-seed-data'

// POST /api/ai/training/knowledge/seed — Bulk import sample FAQs
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: profile } = await supabase.from('user_profiles').select('id, organization_id').single()
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Check if FAQs already exist for this org
  const { count } = await supabase
    .from('ai_knowledge_articles')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', profile.organization_id)

  if (count && count > 0) {
    return NextResponse.json(
      { error: 'Knowledge base already has articles. Delete existing articles first or use the regular create endpoint.' },
      { status: 409 }
    )
  }

  // Bulk insert all FAQs
  const articles = FAQ_SEED_DATA.map((faq) => ({
    organization_id: profile.organization_id,
    created_by: profile.id,
    title: faq.title,
    category: faq.category,
    content: faq.content,
    tags: faq.tags,
    is_enabled: true,
  }))

  // Insert in batches of 50 to avoid payload limits
  let totalInserted = 0
  for (let i = 0; i < articles.length; i += 50) {
    const batch = articles.slice(i, i + 50)
    const { error } = await supabase.from('ai_knowledge_articles').insert(batch)
    if (error) {
      return NextResponse.json(
        { error: `Failed at batch ${Math.floor(i / 50) + 1}: ${error.message}`, inserted: totalInserted },
        { status: 500 }
      )
    }
    totalInserted += batch.length
  }

  return NextResponse.json({
    success: true,
    inserted: totalInserted,
    message: `Successfully loaded ${totalInserted} FAQ articles into your knowledge base.`,
  }, { status: 201 })
}
