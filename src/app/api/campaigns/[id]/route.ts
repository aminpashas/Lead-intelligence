/**
 * PATCH /api/campaigns/[id] — update per-campaign playbook settings.
 *
 * Currently exposes the per-campaign financing prequal control
 * (`playbook.prequal_mode`). The playbook is jsonb, so we read-merge-write to
 * avoid clobbering the campaign's goal/tone/hooks/guardrails. Org-scoped; the
 * route is gated on `campaigns:write` via the middleware permission map.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import type { CampaignPlaybook } from '@/types/database'

const PREQUAL_MODES = ['inherit', 'enabled', 'disabled'] as const
type PrequalMode = (typeof PREQUAL_MODES)[number]

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { prequal_mode?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.prequal_mode || !PREQUAL_MODES.includes(body.prequal_mode as PrequalMode)) {
    return NextResponse.json(
      { error: "prequal_mode must be one of 'inherit' | 'enabled' | 'disabled'" },
      { status: 400 }
    )
  }

  // Read the existing playbook (org-scoped) so we merge, not overwrite.
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('playbook')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single<{ playbook: CampaignPlaybook | null }>()

  if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })

  const nextPlaybook: CampaignPlaybook = {
    ...(campaign.playbook ?? {}),
    prequal_mode: body.prequal_mode as PrequalMode,
  }

  const { error } = await supabase
    .from('campaigns')
    .update({ playbook: nextPlaybook })
    .eq('id', id)
    .eq('organization_id', orgId)

  if (error) return NextResponse.json({ error: 'Failed to update campaign' }, { status: 500 })

  return NextResponse.json({ success: true, prequal_mode: body.prequal_mode })
}
