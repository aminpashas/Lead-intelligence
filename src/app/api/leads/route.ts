import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createLeadSchema } from '@/lib/validators/lead'
import { encryptLeadPII, decryptLeadsPII } from '@/lib/encryption'
import { auditPHIRead, auditPHIWrite } from '@/lib/hipaa-audit'

// GET /api/leads - List leads with filters
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { searchParams } = new URL(request.url)

  const status = searchParams.get('status')
  const qualification = searchParams.get('qualification')
  const stage_id = searchParams.get('stage_id')
  const assigned_to = searchParams.get('assigned_to')
  const source_id = searchParams.get('source_id')
  const search = searchParams.get('search')
  const sort_by = searchParams.get('sort_by') || 'created_at'
  const sort_order = searchParams.get('sort_order') || 'desc'
  const page = parseInt(searchParams.get('page') || '1')
  const per_page = parseInt(searchParams.get('per_page') || '50')

  let query = supabase
    .from('leads')
    .select('*, pipeline_stage:pipeline_stages(*), source:lead_sources(*), assigned_user:user_profiles!leads_assigned_to_fkey(*)', { count: 'exact' })

  if (status) {
    const statuses = status.split(',')
    query = query.in('status', statuses)
  }
  if (qualification) {
    query = query.eq('ai_qualification', qualification)
  }
  if (stage_id) {
    query = query.eq('stage_id', stage_id)
  }
  if (assigned_to) {
    query = query.eq('assigned_to', assigned_to)
  }
  if (source_id) {
    query = query.eq('source_id', source_id)
  }
  if (search) {
    query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%`)
  }

  // Sorting
  const ascending = sort_order === 'asc'
  query = query.order(sort_by, { ascending })

  // Pagination
  const from = (page - 1) * per_page
  const to = from + per_page - 1
  query = query.range(from, to)

  const { data, error, count } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Get org for audit logging
  const { data: auditProfile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .single()

  if (auditProfile && data && data.length > 0) {
    auditPHIRead(
      { supabase, organizationId: auditProfile.organization_id, actorId: auditProfile.id },
      'lead',
      `batch:${data.length}`,
      `Accessed ${data.length} lead records (page ${page})`,
    )
  }

  return NextResponse.json({
    leads: decryptLeadsPII(data || []),
    pagination: {
      page,
      per_page,
      total: count || 0,
      total_pages: Math.ceil((count || 0) / per_page),
    },
  })
}

// POST /api/leads - Create a new lead
export async function POST(request: NextRequest) {
  const supabase = await createClient()

  const body = await request.json()
  const parsed = createLeadSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  // Get user's organization
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'User profile not found' }, { status: 401 })
  }

  // Get default pipeline stage
  const { data: defaultStage } = await supabase
    .from('pipeline_stages')
    .select('id')
    .eq('organization_id', profile.organization_id)
    .eq('is_default', true)
    .single()

  // Format phone for Twilio
  let phoneFormatted: string | undefined
  if (parsed.data.phone) {
    const cleaned = parsed.data.phone.replace(/\D/g, '')
    phoneFormatted = cleaned.startsWith('1') ? `+${cleaned}` : `+1${cleaned}`
  }

  const insertData = encryptLeadPII({
    ...parsed.data,
    organization_id: profile.organization_id,
    stage_id: defaultStage?.id,
    phone_formatted: phoneFormatted,
    email: parsed.data.email || null,
  })

  const { data: lead, error } = await supabase
    .from('leads')
    .insert(insertData)
    .select('*, pipeline_stage:pipeline_stages(*)')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Log activity + HIPAA audit
  await supabase.from('lead_activities').insert({
    organization_id: profile.organization_id,
    lead_id: lead.id,
    activity_type: 'created',
    title: 'Lead created',
    description: `${lead.first_name} ${lead.last_name || ''} added to pipeline`,
  })

  auditPHIWrite(
    { supabase, organizationId: profile.organization_id },
    'lead',
    lead.id,
    'New lead created with PII (encrypted at rest)',
  )

  return NextResponse.json({ lead: decryptLeadsPII([lead as any])[0] }, { status: 201 })
}
