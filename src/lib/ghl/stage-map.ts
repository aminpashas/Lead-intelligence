/**
 * Map a GHL pipeline's stages onto the org's EXISTING LI `pipeline_stages`.
 *
 * Why: the LI Pipeline board groups leads by `stage_id`, so every synced GHL
 * opportunity must resolve to a real LI stage or it won't appear on the board.
 *
 * Authority: LI owns its pipeline; GHL is a capture source, not the pipeline
 * definition. So this NEVER creates stages. A GHL stage whose slug matches an
 * existing LI stage maps onto it; anything unrecognized (or blank-named) maps
 * onto the org's intake column (its lowest-position stage, typically "New
 * Lead"). LI-side staff then move leads to the right stage. Idempotent.
 *
 * History: an earlier version find-or-CREATED unmatched GHL stages, appending
 * them after the org's max position. Because the seeded default stages used
 * different slugs (LI "New Lead" → `new` vs GHL's `new-lead`), a 28-stage GHL
 * pipeline appended wholesale onto the clean 11-stage default — a 39-column,
 * unusable board with a duplicate "New Lead". Map-only prevents that recurring.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { GhlPipeline } from './types'

/** lowercase, alphanumerics → single dashes, trimmed. Stable across runs. */
export function slugifyStageName(name: string): string {
  return (name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

type ExistingStage = { id: string; slug: string; position: number | null }

/**
 * Returns a map of GHL stage id → existing LI pipeline_stages id. Never mutates
 * `pipeline_stages`. GHL stages matching an LI slug map onto it; everything else
 * (including blank names) maps onto the org's intake stage so the lead still
 * lands on the board. Empty map only when the org has no stages at all.
 */
export async function ensureStageMapping(
  supabase: SupabaseClient,
  organizationId: string,
  pipeline: GhlPipeline,
): Promise<Record<string, string>> {
  const stages = pipeline.stages ?? []
  if (stages.length === 0) return {}

  const { data: existingRows } = await supabase
    .from('pipeline_stages')
    .select('id, slug, position')
    .eq('organization_id', organizationId)

  const existing = (existingRows ?? []) as ExistingStage[]

  // Index by slug, and pick the intake column (lowest position) as the fallback
  // home for any GHL stage LI doesn't recognize.
  const bySlug = new Map<string, string>()
  let fallbackId: string | null = null
  let fallbackPos = Infinity
  for (const row of existing) {
    if (row.slug) bySlug.set(row.slug, row.id)
    const pos = typeof row.position === 'number' ? row.position : Infinity
    if (pos < fallbackPos) {
      fallbackPos = pos
      fallbackId = row.id
    }
  }

  const map: Record<string, string> = {}
  for (const st of stages) {
    const slug = slugifyStageName(st.name)
    const target = (slug && bySlug.get(slug)) || fallbackId
    if (target) map[st.id] = target
  }

  return map
}
