/**
 * /api/v1/leads — service-key authenticated bridge endpoint.
 *
 * Consumed by sibling Vercel projects (currently dion-growth-studio) that
 * don't have a user session. Uses the Supabase service role key to bypass
 * RLS, with the caller-supplied customer_id treated as the
 * organization_id (both are UUIDs and the partner systems map 1:1).
 *
 * GET  /api/v1/leads?customer_id=<uuid>&limit=<n>
 *   Returns { leads: LeadIntelLead[] } — schema matches the bridge's
 *   expected response shape in dion-growth-studio.
 *
 * POST /api/v1/leads
 *   Body: { customer_id, full_name, email?, phone?, source, notes? }
 *   Splits full_name into first_name/last_name, looks up source by name,
 *   encrypts PII, audits as HIPAA PHI write. Returns { id, lead_id }.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyServiceKey } from '@/lib/auth/service-key'
import { encryptLeadPII, decryptLeadsPII } from '@/lib/encryption'
import { auditPHIRead, auditPHIWrite } from '@/lib/hipaa-audit'
import { formatToE164 } from '@/lib/leads/phone'
import { safeParseBody } from '@/lib/body-size'

const MAX_LIMIT = 200

function serviceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase service role not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

function splitName(full: string): { first_name: string; last_name: string | null } {
  const trimmed = (full ?? '').trim()
  if (!trimmed) return { first_name: 'Unknown', last_name: null }
  const idx = trimmed.indexOf(' ')
  if (idx < 0) return { first_name: trimmed, last_name: null }
  return {
    first_name: trimmed.slice(0, idx),
    last_name: trimmed.slice(idx + 1).trim() || null,
  }
}

// GET /api/v1/leads?customer_id=<org-uuid>&limit=<n>
export async function GET(request: NextRequest) {
  const caller = verifyServiceKey(request)
  if (!caller) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const customerId = searchParams.get('customer_id')
  if (!customerId) {
    return NextResponse.json({ error: 'customer_id is required' }, { status: 400 })
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(searchParams.get('limit') ?? '50') || 50))

  const supabase = serviceRoleClient()
  const { data, error } = await supabase
    .from('leads')
    .select('id, organization_id, first_name, last_name, email, phone, status, source_type, utm_source, lead_source:lead_sources(name), created_at, last_contacted_at')
    .eq('organization_id', customerId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const decrypted = decryptLeadsPII(data ?? [])
  const leads = decrypted.map((l: Record<string, unknown>) => ({
    id: String(l.id),
    customer_id: String(l.organization_id),
    full_name: [l.first_name, l.last_name].filter(Boolean).join(' ').trim() || null,
    email: (l.email as string) ?? null,
    phone: (l.phone as string) ?? null,
    status: String(l.status ?? 'new'),
    source:
      ((l.lead_source as { name?: string } | null)?.name) ??
      (l.source_type as string) ??
      (l.utm_source as string) ??
      null,
    created_at: String(l.created_at),
    last_contacted_at: (l.last_contacted_at as string) ?? null,
  }))

  if (leads.length > 0) {
    await auditPHIRead(
      { supabase, organizationId: customerId, actorType: 'system', actorId: caller },
      'lead',
      `bridge:${caller}:${leads.length}`,
      `Service-key read of ${leads.length} leads by ${caller}`,
    )
  }

  return NextResponse.json({ leads })
}

// POST /api/v1/leads — create a lead via service key
export async function POST(request: NextRequest) {
  const caller = verifyServiceKey(request)
  if (!caller) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: body, error: bodyError } = await safeParseBody(request)
  if (bodyError) return bodyError

  const customerId = (body as Record<string, unknown>)?.customer_id
  const fullName = (body as Record<string, unknown>)?.full_name
  if (typeof customerId !== 'string' || !customerId) {
    return NextResponse.json({ error: 'customer_id is required' }, { status: 400 })
  }
  if (typeof fullName !== 'string' || !fullName.trim()) {
    return NextResponse.json({ error: 'full_name is required' }, { status: 400 })
  }

  const { first_name, last_name } = splitName(fullName)
  const email = typeof (body as Record<string, unknown>)?.email === 'string'
    ? ((body as Record<string, string>).email || null)
    : null
  const phoneRaw = typeof (body as Record<string, unknown>)?.phone === 'string'
    ? (body as Record<string, string>).phone
    : ''
  const phoneFormatted = phoneRaw ? formatToE164(phoneRaw) : null
  const sourceName = typeof (body as Record<string, unknown>)?.source === 'string'
    ? (body as Record<string, string>).source
    : null
  const notes = typeof (body as Record<string, unknown>)?.notes === 'string'
    ? (body as Record<string, string>).notes
    : null

  const supabase = serviceRoleClient()

  // Look up source_id by name (or null if not found) — keeps the call
  // idempotent without forcing the caller to know LI's internal source IDs.
  let source_id: string | null = null
  if (sourceName) {
    const { data: src } = await supabase
      .from('lead_sources')
      .select('id')
      .eq('organization_id', customerId)
      .ilike('name', sourceName)
      .maybeSingle()
    source_id = src?.id ?? null
  }

  // Default pipeline stage for the org.
  const { data: defaultStage } = await supabase
    .from('pipeline_stages')
    .select('id')
    .eq('organization_id', customerId)
    .eq('is_default', true)
    .maybeSingle()

  const insertData = encryptLeadPII({
    organization_id: customerId,
    first_name,
    last_name,
    email,
    phone: phoneRaw || null,
    phone_formatted: phoneFormatted ?? undefined,
    stage_id: defaultStage?.id,
    source_id,
    internal_notes: notes,
  })

  const { data: lead, error } = await supabase
    .from('leads')
    .insert(insertData)
    .select('id')
    .single()

  if (error || !lead) {
    return NextResponse.json({ error: error?.message ?? 'Insert failed' }, { status: 500 })
  }

  await supabase.from('lead_activities').insert({
    organization_id: customerId,
    lead_id: lead.id,
    activity_type: 'created',
    title: `Lead created via ${caller}`,
    description: `${first_name} ${last_name ?? ''}`.trim() + ` added by service bridge`,
  })

  await auditPHIWrite(
    { supabase, organizationId: customerId, actorType: 'system', actorId: caller },
    'lead',
    String(lead.id),
    `Service-key lead creation by ${caller}`,
  )

  return NextResponse.json({ id: lead.id, lead_id: lead.id }, { status: 201 })
}
