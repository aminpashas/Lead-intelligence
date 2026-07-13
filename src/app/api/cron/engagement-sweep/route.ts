/**
 * Engagement sweep — every 15 minutes (via batch-15m).
 *
 * Two jobs, both cheap and deterministic (no LLM calls):
 *
 *  1. RECOMPUTE: one set-based `recompute_lead_engagement()` RPC refreshes
 *     `engagement_score` + `engagement_temperature` for every lead whose value
 *     changed (formula: src/lib/engagement/temperature.ts). This is what keeps
 *     the /leads meter honest — counters are maintained by the messaging paths,
 *     the sweep just re-derives the meter from them as time passes.
 *
 *  2. COOL-DOWN MOVES: leads in the *working* funnel (Following Up / Engaged)
 *     whose temperature has decayed to `cold` are moved into Nurturing — the
 *     stage's actual meaning: worked leads that went silent and need warming
 *     back up. Fresh intake never lands here anymore (see
 *     lib/leads/intake-routing.ts); cooling is now the ONLY automated way in.
 *
 * Moves go through the shared `applyStageMove` engine so every move writes a
 * `stage_changed` activity, but with automations SUPPRESSED: a decay sweep that
 * can touch hundreds of leads a run must not mass-trigger campaign entries.
 * Nurture enrollment stays a deliberate human/campaign-targeting decision.
 *
 * Kill switch: ENGAGEMENT_SWEEP_DISABLED=true.
 * Tunable: ENGAGEMENT_SWEEP_MAX_MOVES (default 200 per run — the backlog
 * drains over a few runs rather than one giant batch).
 */

import { withCron } from '@/lib/cron/with-cron'
import { applyStageMove } from '@/lib/pipeline/stage-move'
import { ACTIVE_CONTACT_STAGE_SLUGS } from '@/lib/pipeline/stage-groups'
import { NURTURE_STAGE_SLUG } from '@/lib/leads/intake-routing'

export const runtime = 'nodejs'
export const maxDuration = 300

const MAX_MOVES = Number(process.env.ENGAGEMENT_SWEEP_MAX_MOVES) || 200
const TERMINAL_STATUSES = '(lost,disqualified,completed,in_treatment)'

export const POST = withCron('engagement-sweep', async ({ supabase }) => {
  if (process.env.ENGAGEMENT_SWEEP_DISABLED === 'true') {
    return { status: 'skipped', items: 0, data: { message: 'ENGAGEMENT_SWEEP_DISABLED' } }
  }

  // 1. Set-based recompute across all orgs (only changed rows are written).
  const { data: recomputed, error: rpcError } = await supabase.rpc('recompute_lead_engagement')
  if (rpcError) {
    // The meter is the sweep's core job — if the RPC is missing/broken, surface
    // loudly instead of silently skipping to the move phase.
    throw new Error(`recompute_lead_engagement failed: ${rpcError.message}`)
  }

  // 2. Cool-down moves: worked leads that went cold → Nurturing.
  const { data: stageRows } = await supabase
    .from('pipeline_stages')
    .select('id, slug, organization_id')
    .in('slug', [...ACTIVE_CONTACT_STAGE_SLUGS, NURTURE_STAGE_SLUG])

  // org → { working: stage ids, nurturing: stage id }
  const byOrg = new Map<string, { working: string[]; nurturing: string | null }>()
  for (const s of stageRows ?? []) {
    const entry = byOrg.get(s.organization_id) ?? { working: [], nurturing: null }
    if (s.slug === NURTURE_STAGE_SLUG) entry.nurturing = s.id
    else entry.working.push(s.id)
    byOrg.set(s.organization_id, entry)
  }

  let moved = 0
  const errors: string[] = []

  for (const [orgId, stages] of byOrg) {
    if (moved >= MAX_MOVES) break
    if (!stages.nurturing || stages.working.length === 0) continue

    const { data: coldLeads } = await supabase
      .from('leads')
      .select('id')
      .eq('organization_id', orgId)
      .eq('engagement_temperature', 'cold')
      .in('stage_id', stages.working)
      .not('status', 'in', TERMINAL_STATUSES)
      .limit(MAX_MOVES - moved)

    if (!coldLeads || coldLeads.length === 0) continue

    const result = await applyStageMove(supabase, {
      organizationId: orgId,
      leadIds: coldLeads.map((l: { id: string }) => l.id),
      toStageId: stages.nurturing,
      actor: { type: 'system', source: 'engagement_sweep' },
      // A decay sweep must never mass-fire campaign entries — see header.
      suppressAutomations: true,
      activityTitle: 'Went cold — moved to Nurturing',
      activityMetadata: { reason: 'engagement_cold' },
    })
    moved += result.moved
    if (result.error) errors.push(`${orgId}: ${result.error}`)
  }

  return {
    items: moved,
    data: { recomputed: recomputed ?? 0, moved, errors: errors.slice(0, 10) },
  }
})

export const GET = POST
