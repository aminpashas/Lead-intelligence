import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { decryptLeadsPII, encryptLeadPII } from '@/lib/encryption'
import { auditPHIRead, auditPHIWrite } from '@/lib/hipaa-audit'
import { createLeadSchema } from '@/lib/validators/lead'
import { safeParseBody } from '@/lib/body-size'
import { formatToE164 } from '@/lib/leads/phone'

/**
 * Public machine-to-machine API for trusted Dion partner apps (e.g. Dion Growth
 * Studio's leads view). Unlike /api/leads — which authenticates via the Supabase
 * session cookie and scopes to the logged-in user's organization — this route has
 * no cookie. It authenticates with a shared partner key and scopes explicitly to
 * the requested organization via the service-role client (RLS-bypassed, so the
 * tenant filter below is the only thing standing between callers and other orgs'
 * PHI — keep it).
 *
 * Auth:  Authorization: Bearer <DION_PARTNER_API_KEY>
 * Query: customer_id = organization UUID (required), limit (1–200, default 50)
 */

const MAX_LIMIT = 200
const DEFAULT_LIMIT = 50
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Authenticated PHI endpoint: never cache, always run server-side.
export const dynamic = 'force-dynamic'

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  // timingSafeEqual throws on length mismatch; a length check leaks only length.
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.DION_PARTNER_API_KEY
  if (!expected) return false // fail closed if the key isn't provisioned
  const header = request.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  return token.length > 0 && constantTimeEqual(token, expected)
}

// GET /api/v1/leads?customer_id=<organization_id>&limit=50
export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const customerId = searchParams.get('customer_id')?.trim()
  if (!customerId || !UUID_RE.test(customerId)) {
    return NextResponse.json(
      { error: 'customer_id (organization UUID) is required' },
      { status: 400 },
    )
  }

  const limitParam = Number(searchParams.get('limit') ?? DEFAULT_LIMIT)
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(1, Math.trunc(limitParam)), MAX_LIMIT)
    : DEFAULT_LIMIT

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('leads')
    .select(
      'id, organization_id, first_name, last_name, email, phone, status, source_type, utm_source, created_at, last_contacted_at',
    )
    .eq('organization_id', customerId) // hard tenant scope — service-role bypasses RLS
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // email/phone are encrypted at rest (PII_FIELDS) — decrypt before returning.
  const rows = decryptLeadsPII(data ?? [])

  const leads = rows.map((l) => {
    const fullName = [l.first_name, l.last_name].filter(Boolean).join(' ').trim()
    return {
      id: l.id,
      customer_id: l.organization_id,
      full_name: fullName || null,
      email: l.email ?? null,
      phone: l.phone ?? null,
      status: l.status,
      source: l.source_type ?? l.utm_source ?? null,
      created_at: l.created_at,
      last_contacted_at: l.last_contacted_at ?? null,
    }
  })

  // HIPAA §164.312(b): record the machine PHI read.
  await auditPHIRead(
    { supabase, organizationId: customerId, actorType: 'system', actorId: 'dion-partner-api' },
    'lead',
    customerId,
    `Partner API listed ${leads.length} lead(s)`,
  )

  return NextResponse.json({ leads })
}

/**
 * POST /api/v1/leads — push a lead into an organization's pipeline.
 *
 * Partner-friendly body (what Dion Growth Studio sends):
 *   { customer_id, full_name, email?, phone?, source?, notes? }
 * full_name is split into first/last; source maps to source_type. The lead is
 * inserted via the same encrypt-at-rest + activity-log + audit path as the
 * cookie route, but the org comes from customer_id rather than a user session.
 */
export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: body, error: bodyError } = await safeParseBody(request)
  if (bodyError) return bodyError

  const raw = (body ?? {}) as Record<string, unknown>
  const customerId = typeof raw.customer_id === 'string' ? raw.customer_id.trim() : ''
  if (!UUID_RE.test(customerId)) {
    return NextResponse.json(
      { error: 'customer_id (organization UUID) is required' },
      { status: 400 },
    )
  }

  // Split "full_name" into first/last for the leads schema (first_name required).
  const fullName = typeof raw.full_name === 'string' ? raw.full_name.trim() : ''
  const [firstName, ...rest] = fullName.split(/\s+/)
  const leadFields = {
    first_name: firstName ?? '',
    last_name: rest.length ? rest.join(' ') : undefined,
    email: typeof raw.email === 'string' ? raw.email : undefined,
    phone: typeof raw.phone === 'string' ? raw.phone : undefined,
    source_type: typeof raw.source === 'string' ? raw.source : undefined,
    notes: typeof raw.notes === 'string' ? raw.notes : undefined,
  }

  const parsed = createLeadSchema.safeParse(leadFields)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 },
    )
  }

  const supabase = createServiceClient()

  // Default pipeline stage for this org, if one is configured.
  const { data: defaultStage } = await supabase
    .from('pipeline_stages')
    .select('id')
    .eq('organization_id', customerId)
    .eq('is_default', true)
    .maybeSingle()

  const phoneFormatted = formatToE164(parsed.data.phone) ?? undefined
  const insertData = encryptLeadPII({
    ...parsed.data,
    organization_id: customerId,
    stage_id: defaultStage?.id,
    phone_formatted: phoneFormatted,
    email: parsed.data.email || null,
  })

  const { data: lead, error } = await supabase
    .from('leads')
    .insert(insertData)
    .select('id, first_name, last_name')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  await supabase.from('lead_activities').insert({
    organization_id: customerId,
    lead_id: lead.id,
    activity_type: 'created',
    title: 'Lead created',
    description: `${lead.first_name} ${lead.last_name || ''} added via partner API`.trim(),
  })

  await auditPHIWrite(
    { supabase, organizationId: customerId, actorType: 'system', actorId: 'dion-partner-api' },
    'lead',
    lead.id,
    'Lead created via partner API with PII (encrypted at rest)',
  )

  return NextResponse.json({ id: lead.id }, { status: 201 })
}
