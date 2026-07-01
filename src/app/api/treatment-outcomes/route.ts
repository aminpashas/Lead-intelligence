import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { recordTreatmentOutcome, type TreatmentOutcomeValue } from '@/lib/treatment/outcomes'
import { auditPHIWrite } from '@/lib/hipaa-audit'

export const runtime = 'nodejs'

const VALID_OUTCOMES: TreatmentOutcomeValue[] = ['success', 'complication', 'revision', 'failure']

async function authCtx() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .eq('id', user.id)
    .single()
  if (!profile) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  // Effective org honors an agency_admin's entered client account.
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  return { supabase, user, organizationId: orgId }
}

// GET /api/treatment-outcomes?lead_id=... — outcomes for a lead (RLS-scoped to org).
export async function GET(request: NextRequest) {
  const c = await authCtx()
  if ('error' in c) return c.error

  const leadId = new URL(request.url).searchParams.get('lead_id')
  if (!leadId) return NextResponse.json({ error: 'lead_id is required' }, { status: 400 })

  const { data, error } = await c.supabase
    .from('treatment_outcomes')
    .select(
      'id, lead_id, outcome, satisfaction_score, follow_up_attended, revision_required, final_revenue, notes, occurred_at, created_at'
    )
    .eq('lead_id', leadId)
    .order('occurred_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ outcomes: data ?? [] })
}

// POST /api/treatment-outcomes — record a post-treatment outcome for a lead.
export async function POST(request: NextRequest) {
  const c = await authCtx()
  if ('error' in c) return c.error

  const body = await request.json().catch(() => ({}))
  const leadId = body.lead_id
  const outcome = body.outcome as TreatmentOutcomeValue
  if (!leadId || !VALID_OUTCOMES.includes(outcome)) {
    return NextResponse.json(
      { error: `lead_id and a valid outcome (${VALID_OUTCOMES.join(', ')}) are required` },
      { status: 400 }
    )
  }

  // Authorize by confirming the lead is visible to this user — RLS limits the
  // read to the caller's org, so an out-of-org lead resolves to null → 404.
  const { data: lead } = await c.supabase
    .from('leads')
    .select('id, organization_id')
    .eq('id', leadId)
    .maybeSingle()
  if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })

  const satisfaction = body.satisfaction_score == null ? null : Number(body.satisfaction_score)
  if (satisfaction != null && (!Number.isInteger(satisfaction) || satisfaction < 1 || satisfaction > 10)) {
    return NextResponse.json({ error: 'satisfaction_score must be an integer 1-10' }, { status: 400 })
  }

  const service = createServiceClient()
  let result: { id: string }
  try {
    result = await recordTreatmentOutcome(service, {
      organizationId: lead.organization_id,
      leadId,
      outcome,
      treatmentClosingId: body.treatment_closing_id ?? null,
      clinicalCaseId: body.clinical_case_id ?? null,
      satisfactionScore: satisfaction,
      followUpAttended: typeof body.follow_up_attended === 'boolean' ? body.follow_up_attended : null,
      revisionRequired: body.revision_required === true || outcome === 'revision',
      finalRevenue: body.final_revenue == null ? null : Number(body.final_revenue),
      notes: typeof body.notes === 'string' ? body.notes : null,
      recordedBy: c.user.id,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to record outcome' },
      { status: 500 }
    )
  }

  // PHI write audit (HIPAA §164.312(b)). Best-effort inside the helper.
  await auditPHIWrite(
    { supabase: service, organizationId: lead.organization_id, actorId: c.user.id, actorType: 'user' },
    'treatment_outcome',
    result.id,
    `Recorded treatment outcome '${outcome}' for lead ${leadId}`,
    ['medical_record', 'diagnosis']
  )

  return NextResponse.json({ outcome: { id: result.id } }, { status: 201 })
}
