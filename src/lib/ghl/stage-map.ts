/**
 * Mirror a GHL pipeline's stages into LI `pipeline_stages`.
 *
 * Why: the LI Pipeline board groups leads by `stage_id`. To make a synced lead
 * actually appear on the board (the bug the old one-time importer had — it set
 * `status` but no `stage_id`), every GHL stage must resolve to a real LI stage.
 *
 * Strategy: find-or-create by slug. If the org already has a stage whose slug
 * matches the GHL stage name (e.g. both call it "New"), we REUSE it rather than
 * creating a duplicate. Genuinely new GHL stages are appended after the org's
 * current max position. Idempotent across runs.
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
 * Returns a map of GHL stage id → LI pipeline_stages id for the given pipeline,
 * creating any missing LI stages. Stages with no resolvable slug (blank names)
 * are skipped and simply won't appear in the map.
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
  const bySlug = new Map<string, string>()
  let maxPosition = -1
  for (const row of existing) {
    bySlug.set(row.slug, row.id)
    if (typeof row.position === 'number' && row.position > maxPosition) maxPosition = row.position
  }

  // Build the GHL-stage → slug list, skipping blank names and de-duping slugs
  // within this pipeline (two GHL stages slugifying identically share one LI stage).
  const map: Record<string, string> = {}
  const toCreate: { ghlStageId: string; name: string; slug: string; position: number }[] = []
  const plannedSlugs = new Set<string>()
  let nextPosition = maxPosition

  for (const st of stages) {
    const slug = slugifyStageName(st.name)
    if (!slug) continue
    const found = bySlug.get(slug)
    if (found) {
      map[st.id] = found
      continue
    }
    if (plannedSlugs.has(slug)) {
      // Already queued for creation by an earlier stage in this pipeline; the
      // post-insert backfill below will assign both GHL ids to the new row.
      continue
    }
    plannedSlugs.add(slug)
    nextPosition += 1
    toCreate.push({ ghlStageId: st.id, name: st.name, slug, position: nextPosition })
  }

  if (toCreate.length > 0) {
    const { data: inserted, error } = await supabase
      .from('pipeline_stages')
      .insert(
        toCreate.map((s) => ({
          organization_id: organizationId,
          name: s.name,
          slug: s.slug,
          position: s.position,
        })),
      )
      .select('id, slug')

    if (error) throw new Error(`pipeline_stages insert failed: ${error.message}`)

    const newBySlug = new Map<string, string>()
    for (const row of (inserted ?? []) as { id: string; slug: string }[]) {
      newBySlug.set(row.slug, row.id)
    }
    // Assign every GHL stage (including those that shared a slug) to its new LI id.
    for (const st of stages) {
      if (map[st.id]) continue
      const slug = slugifyStageName(st.name)
      const id = newBySlug.get(slug)
      if (id) map[st.id] = id
    }
  }

  return map
}
