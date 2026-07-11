/**
 * Closing row ⇄ patient linking.
 *
 * GET  /api/closing/[id]/link  — candidate patients whose name matches this
 *   closing row, for the "which patient is this?" picker.
 * POST /api/closing/[id]/link  — attach a patient to the row: either a chosen
 *   existing lead ({ leadId }) or a freshly-created bare record ({ create: true }).
 *
 * A closing row is clickable into Call/SMS/Email + the lead detail only once its
 * `lead_id` is set; this is how staff resolve the rows the seed left unlinked
 * because several patients (or none) shared the sheet name. Org-scoped + RLS.
 */
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import {
  createClosingLead,
  listClosingCandidates,
} from '@/lib/pipeline/closing-book-leads'

type Row = { id: string; first_name: string; last_name: string; service: string | null; case_value: number | null }

/** Load the closing row, scoped to the effective org (401 if not reachable). */
async function loadRow(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  id: string
): Promise<Row | null> {
  const { data } = await supabase
    .from('closing_book')
    .select('id, first_name, last_name, service, case_value')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()
  return (data as Row | null) ?? null
}

async function authorize(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return null
  const { data: profile } = await getOwnProfile(supabase, 'id, organization_id')
  if (!profile) return null
  return orgId
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const orgId = await authorize(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const row = await loadRow(supabase, orgId, id)
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const candidates = await listClosingCandidates(supabase, orgId, {
    firstName: row.first_name,
    lastName: row.last_name,
  })
  const name = `${row.first_name} ${row.last_name}`.trim()
  return NextResponse.json({ name, candidates })
}

const bodySchema = z
  .object({
    leadId: z.string().uuid().optional(),
    create: z.literal(true).optional(),
  })
  .refine((b) => !!b.leadId !== !!b.create, {
    message: 'Provide exactly one of leadId or create:true',
  })

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const orgId = await authorize(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const row = await loadRow(supabase, orgId, id)
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let leadId = parsed.data.leadId ?? null

  if (leadId) {
    // The chosen lead must belong to this org (defense in depth over RLS).
    const { data: lead } = await supabase
      .from('leads')
      .select('id')
      .eq('id', leadId)
      .eq('organization_id', orgId)
      .single()
    if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  } else {
    leadId = await createClosingLead(supabase, orgId, {
      firstName: row.first_name,
      lastName: row.last_name,
      service: row.service,
      caseValue: row.case_value,
    })
  }

  const { error } = await supabase
    .from('closing_book')
    .update({ lead_id: leadId, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('organization_id', orgId)
  if (error) return NextResponse.json({ error: 'Update failed' }, { status: 500 })

  return NextResponse.json({ leadId, created: !parsed.data.leadId })
}
