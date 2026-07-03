import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { hasPermission } from '@/lib/auth/permissions'
import { getTreatmentClosingByCase } from '@/lib/treatment/treatment-closing'
import type { FmrIntake } from '@/types/database'

/**
 * GET   /api/cases/[id]/intake — the FMR pre-surgical intake bag for the case's closing.
 * PATCH /api/cases/[id]/intake — merge-update the intake bag (coordinator form).
 *
 * These fields feed the FMR contract's merge variables and the conditional smoker
 * consent (see docs/fmr-contract/FMR-Intake-Field-Spec.md). Authorization mirrors the
 * closing panel: staff with case access manage the same surgical-episode row.
 */

const intakeSchema = z
  .object({
    preferred_pharmacy: z.string().max(300),
    pcp_name: z.string().max(200),
    pcp_phone: z.string().max(40),
    driver_name: z.string().max(200),
    driver_phone: z.string().max(40),
    emergency_contact_name: z.string().max(200),
    emergency_contact_phone: z.string().max(40),
    uses_tobacco_vape_marijuana: z.boolean(),
    preop_date: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal('')]),
    discount_amount: z.number().nonnegative().max(1_000_000),
  })
  .partial()
  .strict()

async function authorize(request: NextRequest, caseId: string) {
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single()
  if (!profile || !hasPermission(profile.role, 'cases:read')) {
    return { error: NextResponse.json({ error: 'Access denied' }, { status: 403 }) }
  }

  const { data: caseRow } = await supabase
    .from('clinical_cases')
    .select('id, organization_id')
    .eq('id', caseId)
    .eq('organization_id', orgId)
    .single()
  if (!caseRow) return { error: NextResponse.json({ error: 'Case not found' }, { status: 404 }) }

  return { supabase, orgId }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params
  const auth = await authorize(request, caseId)
  if ('error' in auth) return auth.error

  const closing = await getTreatmentClosingByCase(auth.supabase, caseId)
  return NextResponse.json({ intake: (closing?.intake ?? {}) as FmrIntake })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params
  const auth = await authorize(request, caseId)
  if ('error' in auth) return auth.error
  const { supabase, orgId } = auth

  const parsed = intakeSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })
  }

  const closing = await getTreatmentClosingByCase(supabase, caseId)
  if (!closing) {
    return NextResponse.json({ error: 'Start the closing before recording intake' }, { status: 409 })
  }

  // Merge over the existing bag so partial saves don't clobber other fields.
  const merged: FmrIntake = { ...(closing.intake ?? {}), ...parsed.data }

  const { error } = await supabase
    .from('treatment_closings')
    .update({ intake: merged })
    .eq('id', closing.id)
    .eq('organization_id', orgId)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ intake: merged })
}
