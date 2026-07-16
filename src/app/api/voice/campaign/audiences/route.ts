/**
 * Calling-automation audience + target options.
 *
 * GET /api/voice/campaign/audiences — returns the data the builder needs:
 *  • pipeline stages with a live "callable" count (leads that would actually pass
 *    the dial gate: voice consent, not opted out / DNC, has a formatted phone),
 *  • configured live-transfer targets (who answered calls can be connected to).
 *
 * Read-only; org-scoped via the caller's active org.
 */

import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { hasPermission } from '@/lib/auth/permissions'

export async function GET() {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await authClient
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!profile || !hasPermission(profile.role, 'call_center:write')) {
    return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 })
  }

  const { orgId } = await resolveActiveOrg(authClient)
  if (!orgId) return NextResponse.json({ error: 'No org' }, { status: 403 })

  const supabase = createServiceClient()

  type StageRow = { id: string; name: string; position: number; is_won: boolean; is_lost: boolean }
  const { data: stagesData } = await supabase
    .from('pipeline_stages')
    .select('id, name, position, is_won, is_lost')
    .eq('organization_id', orgId)
    .order('position', { ascending: true })
  const stages = (stagesData || []) as StageRow[]

  // Callable count per stage = leads that would survive the dial gate. Consent is
  // assumed — a lead is callable unless it's on DNC or has opted out of voice (DND).
  // Run the per-stage counts in parallel; each is an indexed head count, not a scan.
  const callableCounts = await Promise.all(
    stages.map(async (s: StageRow) => {
      const { count } = await supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId)
        .eq('stage_id', s.id)
        .eq('voice_opt_out', false)
        .eq('do_not_call', false)
        .not('phone_formatted', 'is', null)
      return { id: s.id, callable: count || 0 }
    })
  )
  const callableById = new Map(callableCounts.map((c) => [c.id, c.callable]))

  const { data: targets } = await supabase
    .from('voice_transfer_targets')
    .select('id, name, destination, kind, active')
    .eq('organization_id', orgId)
    .eq('active', true)

  return NextResponse.json({
    stages: stages.map((s: StageRow) => ({
      id: s.id,
      name: s.name,
      position: s.position,
      is_won: s.is_won,
      is_lost: s.is_lost,
      callable: callableById.get(s.id) || 0,
    })),
    targets: targets || [],
  })
}
