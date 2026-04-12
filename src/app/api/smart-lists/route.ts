import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'
import { resolveSmartListLeads } from '@/lib/campaigns/smart-list-resolver'

const smartListCriteriaSchema = z.object({
  tags: z.object({
    ids: z.array(z.string().uuid()),
    operator: z.enum(['and', 'or']),
  }).optional(),
  statuses: z.array(z.string()).optional(),
  ai_qualifications: z.array(z.string()).optional(),
  score_min: z.number().min(0).max(100).optional(),
  score_max: z.number().min(0).max(100).optional(),
  stages: z.array(z.string().uuid()).optional(),
  source_types: z.array(z.string()).optional(),
  engagement_min: z.number().optional(),
  engagement_max: z.number().optional(),
  states: z.array(z.string()).optional(),
  created_after: z.string().optional(),
  created_before: z.string().optional(),
  has_phone: z.boolean().optional(),
  has_email: z.boolean().optional(),
  sms_consent: z.boolean().optional(),
  email_consent: z.boolean().optional(),
})

const createSmartListSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  icon: z.string().max(50).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#6366F1'),
  criteria: smartListCriteriaSchema,
  is_pinned: z.boolean().optional(),
})

// GET /api/smart-lists — List all Smart Lists
export async function GET() {
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: smartLists, error } = await supabase
    .from('smart_lists')
    .select('*')
    .eq('organization_id', profile.organization_id)
    .order('is_pinned', { ascending: false })
    .order('name')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ smart_lists: smartLists || [] })
}

// POST /api/smart-lists — Create a new Smart List
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const body = await request.json()
  const parsed = createSmartListSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Resolve count for this criteria
  const { count } = await resolveSmartListLeads(
    supabase,
    profile.organization_id,
    parsed.data.criteria,
    { countOnly: true }
  )

  const { data: smartList, error } = await supabase
    .from('smart_lists')
    .insert({
      organization_id: profile.organization_id,
      name: parsed.data.name,
      description: parsed.data.description || null,
      icon: parsed.data.icon || 'list-filter',
      color: parsed.data.color,
      criteria: parsed.data.criteria,
      is_pinned: parsed.data.is_pinned || false,
      lead_count: count,
      last_refreshed_at: new Date().toISOString(),
      created_by: profile.id,
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ smart_list: smartList }, { status: 201 })
}
