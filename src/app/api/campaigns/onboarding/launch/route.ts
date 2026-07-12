import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { hasPermission } from '@/lib/auth/permissions'
import { serviceLineSlugSchema } from '@/lib/validators/practice-profile'
import { getBlueprint, blueprintSystemKey } from '@/lib/campaigns/blueprints'
import { checkCampaignCapacity } from '@/lib/billing/limits'
import { getProfileGaps, renderBlueprintSteps } from '@/lib/campaigns/onboarding'
import {
  getOrCreatePracticeProfile,
  toProfileShape,
} from '@/lib/campaigns/practice-profile'

/**
 * POST /api/campaigns/onboarding/launch — create the blueprint campaign for a
 * service line as a DRAFT (never auto-activates; review + activation happen in
 * the existing campaign UI).
 *
 * Code is the gate: 422 with the gap list while required interview answers are
 * missing; 409 if this line's blueprint campaign already exists (idempotent by
 * metadata->>'system_key', the post-consult-nurture pattern). Admin-only.
 */

const launchSchema = z.object({
  service_line: serviceLineSlugSchema,
})

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { orgId, role } = await resolveActiveOrg(supabase)
  if (!orgId || !role) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // Materializing a blueprint into a campaign (even as a draft) is campaign
  // creation — agency-side. The practice still runs the onboarding interview
  // (profile answers); the agency turns those into live campaigns.
  if (!hasPermission(role, 'campaigns:write')) {
    return NextResponse.json({ error: 'Campaigns are launched by your agency' }, { status: 403 })
  }

  const parsed = launchSchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const blueprint = getBlueprint(parsed.data.service_line)
  const systemKey = blueprintSystemKey(blueprint.slug)

  const profile = await getOrCreatePracticeProfile(supabase, orgId)
  if (!profile) {
    return NextResponse.json({ error: 'Could not load practice profile' }, { status: 500 })
  }

  const shape = toProfileShape(profile)
  const gaps = getProfileGaps(blueprint, shape)
  if (gaps.length > 0) {
    return NextResponse.json(
      { error: 'Onboarding interview incomplete', gaps },
      { status: 422 }
    )
  }

  const { data: existing } = await supabase
    .from('campaigns')
    .select('id, status')
    .eq('organization_id', orgId)
    .eq('metadata->>system_key', systemKey)
    .neq('status', 'archived')
    .limit(1)
    .maybeSingle<{ id: string; status: string }>()
  if (existing) {
    return NextResponse.json(
      { error: `A ${blueprint.name} campaign already exists`, campaign_id: existing.id },
      { status: 409 }
    )
  }

  // Plan quota: a blueprint draft occupies a campaign slot like any other.
  const capacity = await checkCampaignCapacity(supabase, orgId)
  if (!capacity.allowed) {
    return NextResponse.json({ error: capacity.message, code: 'tier_limit' }, { status: 403 })
  }

  const { data: org } = await supabase
    .from('organizations')
    .select('name, phone')
    .eq('id', orgId)
    .maybeSingle<{ name: string; phone: string | null }>()
  if (!org) {
    return NextResponse.json({ error: 'Organization not found' }, { status: 500 })
  }

  let steps
  try {
    steps = renderBlueprintSteps(blueprint, shape, { name: org.name, phone: org.phone })
  } catch (err) {
    // An unresolved [[var]] with zero gaps means a blueprint/pack mismatch — a
    // code bug, not a user problem. Surface it loudly.
    console.error('[onboarding-launch] render failed:', err)
    return NextResponse.json({ error: 'Blueprint rendering failed' }, { status: 500 })
  }

  const timezone =
    typeof (shape.core.hours as Record<string, unknown> | undefined)?.timezone === 'string'
      ? ((shape.core.hours as Record<string, unknown>).timezone as string)
      : 'America/New_York'

  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .insert({
      organization_id: orgId,
      name: `${blueprint.name} — New Lead Nurture`,
      description: blueprint.description,
      type: 'drip',
      channel: 'multi',
      status: 'draft',
      service_line: blueprint.slug,
      target_criteria: blueprint.targetCriteria,
      send_window: { start_hour: 9, end_hour: 19, timezone, days: [1, 2, 3, 4, 5, 6] },
      metadata: {
        system_key: systemKey,
        blueprint_version: blueprint.version,
        profile_snapshot_at: new Date().toISOString(),
        guardrails: blueprint.guardrails,
        kpis: blueprint.kpis,
      },
    })
    .select('id')
    .single<{ id: string }>()

  if (campaignError || !campaign) {
    // A concurrent launch may have won the race — report it as the conflict it is.
    const { data: raced } = await supabase
      .from('campaigns')
      .select('id')
      .eq('organization_id', orgId)
      .eq('metadata->>system_key', systemKey)
      .neq('status', 'archived')
      .limit(1)
      .maybeSingle<{ id: string }>()
    if (raced) {
      return NextResponse.json(
        { error: `A ${blueprint.name} campaign already exists`, campaign_id: raced.id },
        { status: 409 }
      )
    }
    return NextResponse.json({ error: 'Failed to create campaign' }, { status: 500 })
  }

  const stepRows = steps.map((s) => ({
    campaign_id: campaign.id,
    organization_id: orgId,
    step_number: s.step_number,
    name: s.name,
    channel: s.channel,
    delay_minutes: s.delay_minutes,
    delay_type: 'after_previous',
    subject: s.subject ?? null,
    body_template: s.body_template,
    ai_personalize: s.ai_personalize,
    send_condition: s.send_condition ?? null,
    exit_condition: { type: 'if_replied', if_replied: true },
    metadata: { ...(s.metadata ?? {}), blueprint: blueprint.slug },
  }))

  const { error: stepsError } = await supabase.from('campaign_steps').insert(stepRows)
  if (stepsError) {
    // Roll back the empty campaign so a retry can re-launch cleanly.
    await supabase.from('campaigns').delete().eq('id', campaign.id)
    return NextResponse.json({ error: 'Failed to create campaign steps' }, { status: 500 })
  }

  return NextResponse.json({ campaign_id: campaign.id, status: 'draft' }, { status: 201 })
}
