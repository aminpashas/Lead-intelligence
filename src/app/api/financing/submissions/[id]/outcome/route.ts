/**
 * POST /api/financing/submissions/[id]/outcome — record a link-lender decision (Phase 2.B).
 *
 * For link lenders (Cherry/Alpheon/etc.) there's no API/webhook, so staff record
 * the approval/denial they read from the lender portal. Gated by the org
 * `link_lender_tracking` flag. On approval this also marks the parent application
 * approved and flips the lead to financing_approved, so the Closer agent and UI
 * reflect the real outcome.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getOrgFlags, flagOn } from '@/lib/org/flags'
import {
  buildManualOutcomeWrites,
  canRecordOutcome,
  ManualOutcomeError,
  type ManualOutcome,
} from '@/lib/financing/manual-outcome'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: submissionId } = await params

  const authed = await createClient()
  const { data: { user } } = await authed.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await authed
    .from('user_profiles')
    .select('organization_id')
    .eq('id', user.id)
    .single()
  const organizationId = profile?.organization_id
  if (!organizationId) return NextResponse.json({ error: 'No organization' }, { status: 403 })

  const service = createServiceClient()
  const flags = await getOrgFlags(service, organizationId)
  if (!flagOn(flags, 'link_lender_tracking')) {
    return NextResponse.json({ error: 'link_lender_tracking_disabled' }, { status: 409 })
  }

  const body = (await request.json().catch(() => null)) as {
    outcome?: string
    approved_amount?: number
    apr?: number
    term_months?: number
    monthly_payment?: number
    denial_reason?: string
  } | null
  const outcome = body?.outcome
  if (outcome !== 'approved' && outcome !== 'denied') {
    return NextResponse.json({ error: "outcome must be 'approved' or 'denied'" }, { status: 400 })
  }

  // Load the submission, scoped to the staff member's org (RLS via authed client).
  const { data: sub } = await authed
    .from('financing_submissions')
    .select('id, application_id, lead_id, lender_slug, status, organization_id')
    .eq('id', submissionId)
    .maybeSingle()
  if (!sub) return NextResponse.json({ error: 'submission_not_found' }, { status: 404 })
  if (!canRecordOutcome(sub.status)) {
    return NextResponse.json({ error: 'outcome_already_recorded', status: sub.status }, { status: 409 })
  }

  let writes
  try {
    writes = buildManualOutcomeWrites(
      {
        outcome: outcome as ManualOutcome,
        approved_amount: body?.approved_amount,
        apr: body?.apr,
        term_months: body?.term_months,
        monthly_payment: body?.monthly_payment,
        denial_reason: body?.denial_reason,
      },
      sub.lender_slug
    )
  } catch (err) {
    if (err instanceof ManualOutcomeError) return NextResponse.json({ error: err.message }, { status: 400 })
    throw err
  }

  const { error: subErr } = await authed
    .from('financing_submissions')
    .update(writes.submission)
    .eq('id', submissionId)
  if (subErr) return NextResponse.json({ error: subErr.message }, { status: 500 })

  if (writes.application) {
    await authed.from('financing_applications').update(writes.application).eq('id', sub.application_id)
  }
  if (writes.leadFinancingApproved !== null) {
    await authed.from('leads').update({ financing_approved: writes.leadFinancingApproved }).eq('id', sub.lead_id)
  }

  // Audit trail (events is append-only and accepts arbitrary event_type).
  await service.from('events').insert({
    organization_id: organizationId,
    lead_id: sub.lead_id,
    event_type: 'financing_outcome_recorded',
    payload: { submission_id: submissionId, lender: sub.lender_slug, outcome, recorded_by: user.id },
    capi_status: 'na',
    gads_status: 'na',
  }).then(() => undefined, () => undefined)

  return NextResponse.json({ ok: true, outcome })
}
