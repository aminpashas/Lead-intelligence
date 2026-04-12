import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'

const createReactivationSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  goal: z.enum(['re_engage', 'win_back', 'upsell', 'referral_ask']),
  tone: z.enum(['empathetic', 'urgent', 'casual', 'professional']),
  channel: z.enum(['sms', 'email', 'multi']),
  ai_hooks: z.array(z.object({
    strategy: z.enum(['urgency', 'social_proof', 'new_technology', 'special_pricing', 'empathy', 'personalized_value']),
    enabled: z.boolean(),
    custom_text: z.string().nullable().optional(),
  })).optional(),
  engagement_rules: z.object({
    max_attempts: z.number().min(1).max(20),
    cooldown_days: z.number().min(1).max(30),
    escalation_strategy: z.string(),
    stop_on_reply: z.boolean(),
    transition_to_live: z.boolean(),
  }).optional(),
  offers: z.array(z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    type: z.enum(['percentage_off', 'dollar_off', 'free_addon', 'financing_special', 'limited_time']),
    value: z.number().optional(),
    expiry_date: z.string().optional(),
    usage_limit: z.number().optional(),
  })).optional(),
  steps: z.array(z.object({
    step_number: z.number(),
    name: z.string().optional(),
    channel: z.enum(['sms', 'email']),
    delay_minutes: z.number().min(0),
    subject: z.string().optional(),
    body_template: z.string(),
    ai_personalize: z.boolean().optional(),
    exit_condition: z.record(z.string(), z.unknown()).optional(),
  })).optional(),
})

// GET /api/reactivation - List reactivation campaigns
export async function GET() {
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabase
    .from('reactivation_campaigns')
    .select('*, offers:reactivation_offers(*)')
    .eq('organization_id', profile.organization_id)
    .neq('status', 'archived')
    .order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ campaigns: data })
}

// POST /api/reactivation - Create reactivation campaign
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const body = await request.json()
  const parsed = createReactivationSchema.safeParse(body)

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

  const { offers, steps, ...campaignData } = parsed.data

  // 1. Create the underlying campaign in the campaigns table (for enrollment/execution)
  let campaignId: string | null = null
  if (steps && steps.length > 0) {
    const { data: campaign, error: campaignError } = await supabase
      .from('campaigns')
      .insert({
        organization_id: profile.organization_id,
        created_by: profile.id,
        name: `[Reactivation] ${campaignData.name}`,
        description: campaignData.description || `Reactivation campaign: ${campaignData.goal}`,
        type: 'drip' as const,
        channel: campaignData.channel,
        status: 'draft' as const,
        target_criteria: { reactivation: true },
        send_window: { start_hour: 9, end_hour: 20, timezone: 'America/New_York', days: [1, 2, 3, 4, 5, 6] },
      })
      .select('id')
      .single()

    if (campaignError) {
      return NextResponse.json({ error: campaignError.message }, { status: 500 })
    }
    campaignId = campaign.id

    // Create campaign steps
    const { error: stepsError } = await supabase
      .from('campaign_steps')
      .insert(
        steps.map((step) => ({
          ...step,
          campaign_id: campaign.id,
          organization_id: profile.organization_id,
          body_template: step.body_template || '',
        }))
      )

    if (stepsError) {
      return NextResponse.json({ error: stepsError.message }, { status: 500 })
    }
  }

  // 2. Create the reactivation campaign record
  const { data: reactivation, error: reactivationError } = await supabase
    .from('reactivation_campaigns')
    .insert({
      organization_id: profile.organization_id,
      campaign_id: campaignId,
      created_by: profile.id,
      name: campaignData.name,
      description: campaignData.description,
      goal: campaignData.goal,
      tone: campaignData.tone,
      channel: campaignData.channel,
      ai_hooks: campaignData.ai_hooks || [],
      engagement_rules: campaignData.engagement_rules || {
        max_attempts: 5,
        cooldown_days: 3,
        escalation_strategy: 'vary_channel',
        stop_on_reply: true,
        transition_to_live: true,
      },
    })
    .select()
    .single()

  if (reactivationError) {
    return NextResponse.json({ error: reactivationError.message }, { status: 500 })
  }

  // 3. Create offers if provided
  if (offers && offers.length > 0) {
    const { error: offersError } = await supabase
      .from('reactivation_offers')
      .insert(
        offers.map((offer) => ({
          organization_id: profile.organization_id,
          reactivation_campaign_id: reactivation.id,
          name: offer.name,
          description: offer.description,
          type: offer.type,
          value: offer.value,
          expiry_date: offer.expiry_date,
          usage_limit: offer.usage_limit,
        }))
      )

    if (offersError) {
      return NextResponse.json({ error: offersError.message }, { status: 500 })
    }
  }

  return NextResponse.json({ campaign: reactivation }, { status: 201 })
}
