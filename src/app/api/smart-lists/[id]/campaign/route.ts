import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'

const launchCampaignSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  type: z.enum(['drip', 'broadcast', 'trigger']).default('broadcast'),
  channel: z.enum(['sms', 'email', 'multi']).default('sms'),
  steps: z.array(z.object({
    step_number: z.number(),
    name: z.string().optional(),
    channel: z.enum(['sms', 'email']),
    delay_minutes: z.number().min(0),
    delay_type: z.enum(['after_previous', 'after_enrollment', 'specific_time']).optional(),
    subject: z.string().optional(),
    body_template: z.string().min(1),
    ai_personalize: z.boolean().optional(),
  })).min(1),
  send_window: z.object({
    start_hour: z.number().min(0).max(23).optional(),
    end_hour: z.number().min(0).max(23).optional(),
    timezone: z.string().optional(),
    days: z.array(z.number()).optional(),
  }).optional(),
})

// POST /api/smart-lists/:id/campaign — Create campaign targeting this Smart List
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: smartListId } = await params
  const supabase = await createClient()
  const body = await request.json()
  const parsed = launchCampaignSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Verify Smart List exists
  const { data: smartList } = await supabase
    .from('smart_lists')
    .select('id, name, criteria')
    .eq('id', smartListId)
    .eq('organization_id', profile.organization_id)
    .single()

  if (!smartList) {
    return NextResponse.json({ error: 'Smart List not found' }, { status: 404 })
  }

  const { steps, ...campaignData } = parsed.data

  // Create campaign linked to Smart List
  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .insert({
      ...campaignData,
      organization_id: profile.organization_id,
      created_by: profile.id,
      smart_list_id: smartListId,
      target_criteria: smartList.criteria,
      status: 'draft',
    })
    .select()
    .single()

  if (campaignError) {
    return NextResponse.json({ error: campaignError.message }, { status: 500 })
  }

  // Create steps
  if (steps.length > 0) {
    const { error: stepsError } = await supabase
      .from('campaign_steps')
      .insert(
        steps.map((step) => ({
          ...step,
          campaign_id: campaign.id,
          organization_id: profile.organization_id,
        }))
      )

    if (stepsError) {
      return NextResponse.json({ error: stepsError.message }, { status: 500 })
    }
  }

  return NextResponse.json({ campaign }, { status: 201 })
}
