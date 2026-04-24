import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { hasPermission } from '@/lib/auth/permissions'

export const runtime = 'nodejs'

/**
 * GET /api/contracts?status=pending_review
 * Returns org-scoped list for the staff dashboard.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single()
  if (!profile || !hasPermission(profile.role, 'contracts:read')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')
  const limit = Math.min(Number(searchParams.get('limit') ?? 50), 200)

  let query = supabase
    .from('patient_contracts')
    .select(`
      id, status, created_at, updated_at, sent_at, signed_at,
      contract_amount, deposit_amount, financing_type,
      template_version, needs_manual_draft,
      clinical_case_id, lead_id
    `)
    .eq('organization_id', profile.organization_id)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (status) query = query.eq('status', status)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Join patient names in a second query (keeps this simple and RLS-friendly)
  const caseIds = [...new Set((data ?? []).map((r) => r.clinical_case_id).filter(Boolean))]
  const { data: cases } = caseIds.length
    ? await supabase
        .from('clinical_cases')
        .select('id, case_number, patient_name')
        .in('id', caseIds)
    : { data: [] }
  const caseMap = new Map((cases ?? []).map((c) => [c.id, c]))

  return NextResponse.json({
    contracts: (data ?? []).map((r) => ({
      ...r,
      case: caseMap.get(r.clinical_case_id) ?? null,
    })),
  })
}
