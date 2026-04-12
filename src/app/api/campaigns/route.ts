import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'

const createCampaignSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(['drip', 'broadcast', 'trigger']),
  channel: z.enum(['sms', 'email', 'multi']),
  smart_list_id: z.string().uuid().optional(),
  target_criteria: z.record(z.string(), z.unknown()).optional(),
  send_window: z.object({
    start_hour: z.number().min(0).max(23).optional(),
    end_hour: z.number().min(0).max(23).optional(),
    timezone: z.string().optional(),
    days: z.array(z.number()).optional(),
  }).optional(),
  steps: z.array(z.object({
    step_number: z.number(),
    name: z.string().optional(),
    channel: z.enum(['sms', 'email']),
    delay_minutes: z.number().min(0),
    delay_type: z.enum(['after_previous', 'after_enrollment', 'specific_time']).optional(),
    subject: z.string().optional(),
    body_template: z.string().min(1),
    ai_personalize: z.boolean().optional(),
    send_condition: z.record(z.string(), z.unknown()).optional(),
    exit_condition: z.record(z.string(), z.unknown()).optional(),
  })).optional(),
})

// GET /api/campaigns - List campaigns
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')

  let query = supabase
    .from('campaigns')
    .select('*, steps:campaign_steps(count)')
    .order('created_at', { ascending: false })

  if (status) {
    query = query.eq('status', status)
  }

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ campaigns: data })
}

// POST /api/campaigns - Create a campaign with steps
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const body = await request.json()
  const parsed = createCampaignSchema.safeParse(body)

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

  const { steps, smart_list_id, ...campaignData } = parsed.data

  // Create campaign
  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .insert({
      ...campaignData,
      organization_id: profile.organization_id,
      created_by: profile.id,
      smart_list_id: smart_list_id || null,
      status: 'draft',
    })
    .select()
    .single()

  if (campaignError) {
    return NextResponse.json({ error: campaignError.message }, { status: 500 })
  }

  // Create steps if provided
  if (steps && steps.length > 0) {
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
