import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'

/**
 * POST /api/leads/[id]/follow-up-enroll — enroll a lead in the default
 * multi-step follow-up sequence (one active enrollment per lead). The cron
 * (`/api/cron/follow-up-sequences`) fires the due steps, allowlist-gated.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: lead } = await supabase
    .from('leads').select('id').eq('id', id).eq('organization_id', orgId).single()
  if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })

  const { data: enrollment, error } = await supabase
    .from('follow_up_enrollments')
    .upsert(
      { organization_id: orgId, lead_id: id, status: 'active', current_step: 0, enrolled_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { onConflict: 'lead_id' }
    )
    .select('id, status, current_step, enrolled_at')
    .single()
  if (error) return NextResponse.json({ error: 'Failed to enroll', detail: error.message }, { status: 500 })

  return NextResponse.json({ enrollment })
}
