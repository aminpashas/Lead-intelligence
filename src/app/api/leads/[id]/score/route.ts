import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { rescoreAndPersistLead } from '@/lib/ai/scoring'
import { resolveActiveOrg } from '@/lib/auth/active-org'

// POST /api/leads/[id]/score - Score a lead with AI
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  // Auth + org scoping
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get lead data — scoped to org
  const { data: lead, error } = await supabase
    .from('leads')
    .select('*')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (error || !lead) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  }

  try {
    // Pass supabase so scoring includes the lead's enrichment signals AND writes
    // the HIPAA audit log — both were skipped when called with just the lead.
    // rescoreAndPersistLead handles score → persist → activity + interaction logs.
    const scoreResult = await rescoreAndPersistLead(supabase, lead)

    return NextResponse.json({ score: scoreResult })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Scoring failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
