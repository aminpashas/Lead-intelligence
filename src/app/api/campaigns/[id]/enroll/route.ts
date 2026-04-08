import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'

const enrollSchema = z.object({
  lead_ids: z.array(z.string().uuid()).min(1).max(100),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const body = await request.json()
  const parsed = enrollSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json({ error: 'lead_ids required' }, { status: 400 })
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get first step delay
  const { data: firstStep } = await supabase
    .from('campaign_steps')
    .select('delay_minutes')
    .eq('campaign_id', id)
    .eq('step_number', 1)
    .single()

  const nextStepAt = new Date(Date.now() + (firstStep?.delay_minutes || 0) * 60 * 1000).toISOString()

  const enrollments = parsed.data.lead_ids.map((lead_id) => ({
    organization_id: profile.organization_id,
    campaign_id: id,
    lead_id,
    status: 'active',
    current_step: 0,
    next_step_at: nextStepAt,
  }))

  const { data, error } = await supabase
    .from('campaign_enrollments')
    .upsert(enrollments, { onConflict: 'campaign_id,lead_id', ignoreDuplicates: true })
    .select()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ enrolled: data?.length || 0 })
}
