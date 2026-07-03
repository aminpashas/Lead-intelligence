import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { isAdminRole } from '@/lib/auth/permissions'
import { listBlueprints, blueprintSystemKey } from '@/lib/campaigns/blueprints'
import { getProfileGaps } from '@/lib/campaigns/onboarding'
import {
  getOrCreatePracticeProfile,
  toProfileShape,
} from '@/lib/campaigns/practice-profile'

/**
 * GET  /api/campaigns/onboarding/profile — setup-page status: the profile,
 *      the self-serve flag, and per-service-line readiness (gaps + any
 *      already-launched blueprint campaign).
 * PATCH — admin-only: flip self_serve_enabled (the agency's switch that lets
 *      non-admin practice staff run the interview themselves).
 */

export async function GET() {
  const supabase = await createClient()
  const { orgId, role } = await resolveActiveOrg(supabase)
  if (!orgId || !role) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const profile = await getOrCreatePracticeProfile(supabase, orgId)
  if (!profile) {
    return NextResponse.json({ error: 'Could not load practice profile' }, { status: 500 })
  }

  if (!isAdminRole(role) && !profile.self_serve_enabled) {
    return NextResponse.json(
      { error: 'Campaign onboarding is managed by your agency for this practice' },
      { status: 403 }
    )
  }

  const blueprints = listBlueprints()
  const { data: launched } = await supabase
    .from('campaigns')
    .select('id, status, service_line, metadata')
    .eq('organization_id', orgId)
    .in(
      'metadata->>system_key',
      blueprints.map((b) => blueprintSystemKey(b.slug))
    )
    .neq('status', 'archived')

  const shape = toProfileShape(profile)
  const lines = blueprints.map((bp) => {
    const campaign = (launched ?? []).find(
      (c) => (c.metadata as Record<string, unknown> | null)?.system_key === blueprintSystemKey(bp.slug)
    )
    const gaps = getProfileGaps(bp, shape)
    return {
      slug: bp.slug,
      name: bp.name,
      description: bp.description,
      required: bp.requiredProfileFields.length,
      answered: bp.requiredProfileFields.length - gaps.length,
      gaps,
      launched_campaign_id: campaign?.id ?? null,
      launched_campaign_status: campaign?.status ?? null,
    }
  })

  return NextResponse.json({
    self_serve_enabled: profile.self_serve_enabled,
    last_interview_at: profile.last_interview_at,
    lines,
  })
}

const patchSchema = z.object({
  self_serve_enabled: z.boolean(),
})

export async function PATCH(request: NextRequest) {
  const supabase = await createClient()
  const { orgId, role } = await resolveActiveOrg(supabase)
  if (!orgId || !role) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isAdminRole(role)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const parsed = patchSchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  // Ensure the row exists before updating the flag.
  const profile = await getOrCreatePracticeProfile(supabase, orgId)
  if (!profile) {
    return NextResponse.json({ error: 'Could not load practice profile' }, { status: 500 })
  }

  const { error } = await supabase
    .from('practice_profiles')
    .update({ self_serve_enabled: parsed.data.self_serve_enabled })
    .eq('organization_id', orgId)

  if (error) {
    return NextResponse.json({ error: 'Failed to update setting' }, { status: 500 })
  }
  return NextResponse.json({ self_serve_enabled: parsed.data.self_serve_enabled })
}
