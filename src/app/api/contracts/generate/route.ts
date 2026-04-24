import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { hasPermission } from '@/lib/auth/permissions'
import { ensureContractDraftForCase } from '@/lib/contracts/orchestrator'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * POST /api/contracts/generate
 * Body: { case_id: string, force_regenerate?: boolean }
 *
 * Staff-facing. Creates (or returns existing) contract draft for the given case.
 */
export async function POST(request: NextRequest) {
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

  const body = await request.json().catch(() => ({}))
  const caseId = String(body.case_id ?? '')
  if (!caseId) {
    return NextResponse.json({ error: 'case_id is required' }, { status: 400 })
  }

  // Verify case belongs to the org
  const { data: caseRow } = await supabase
    .from('clinical_cases')
    .select('id')
    .eq('id', caseId)
    .eq('organization_id', profile.organization_id)
    .maybeSingle()
  if (!caseRow) return NextResponse.json({ error: 'Case not found' }, { status: 404 })

  const result = await ensureContractDraftForCase({
    organizationId: profile.organization_id,
    caseId,
    actorId: user.id,
    actorType: 'user',
    forceRegenerate: Boolean(body.force_regenerate),
  })

  if (!result.ok) {
    if (result.code === 'missing_legal') {
      return NextResponse.json(
        { error: result.message, missing: result.missing, code: result.code },
        { status: 422 }
      )
    }
    if (result.code === 'case_not_found') {
      return NextResponse.json({ error: result.message, code: result.code }, { status: 404 })
    }
    return NextResponse.json({ error: result.message, code: result.code }, { status: 500 })
  }

  return NextResponse.json({
    contract_id: result.contract_id,
    status: result.status,
    needs_manual_draft: result.needs_manual_draft,
    missing_variables: result.missing_variables,
  })
}
