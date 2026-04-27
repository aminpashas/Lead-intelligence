import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { hasPermission } from '@/lib/auth/permissions'
import { ensureContractDraftForCase } from '@/lib/contracts/orchestrator'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * POST /api/contracts/[id]/regenerate
 * Voids the current contract (if not sent) and creates a fresh draft.
 * V1: full-document regeneration only (no per-section). Only allowed while in draft states.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single()
  if (!profile || !hasPermission(profile.role, 'contracts:generate')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { id } = await params
  const { data: contract } = await supabase
    .from('patient_contracts')
    .select('id, status, organization_id, clinical_case_id')
    .eq('id', id)
    .eq('organization_id', profile.organization_id)
    .maybeSingle()
  if (!contract) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (!['pending_review', 'changes_requested', 'approved'].includes(contract.status)) {
    return NextResponse.json(
      { error: `Cannot regenerate contract in status ${contract.status}` },
      { status: 409 }
    )
  }

  // Void the existing draft so the orchestrator creates a fresh row
  await supabase.from('patient_contracts').update({ status: 'voided' }).eq('id', id)

  const result = await ensureContractDraftForCase({
    organizationId: profile.organization_id,
    caseId: contract.clinical_case_id,
    actorId: user.id,
    actorType: 'user',
    forceRegenerate: true,
  })

  if (!result.ok) {
    if (result.code === 'missing_legal') {
      return NextResponse.json(
        { error: result.message, missing: result.missing, code: result.code },
        { status: 422 }
      )
    }
    return NextResponse.json({ error: result.message, code: result.code }, { status: 500 })
  }

  return NextResponse.json({
    contract_id: result.contract_id,
    status: result.status,
    needs_manual_draft: result.needs_manual_draft,
  })
}
