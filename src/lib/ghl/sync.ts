/**
 * GoHighLevel → Lead Intelligence sync (pull side).
 *
 * For one org: walk every target pipeline's opportunities, mirror their stages
 * into LI, and upsert each opportunity as a lead. Idempotent and incremental:
 *
 *   - Already-imported opportunities (external_ref = `ghl_opp:<id>`) are NOT
 *     re-ingested. We only move their LI stage if it changed in GHL — a cheap
 *     update that needs no contact fetch.
 *   - New opportunities resolve their contact and go through the shared
 *     `ingestLead` path (email/phone-hash dedup converges them with any lead the
 *     DGS bridge already created for the same person).
 *
 * Consent is left UNKNOWN on every synced lead; nothing is auto-contacted.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchPipelines,
  resolveOpportunityContact,
  searchOpportunities,
  SEARCH_PAGE_SIZE,
} from './client'
import { ensureStageMapping } from './stage-map'
import { ingestLead, type IngestInput } from '@/lib/leads/ingest'
import type { GhlConfig, GhlContact, GhlOpportunity, GhlSyncResult } from './types'

/** Hard page cap, matching the original importer — a runaway-loop backstop. */
const MAX_PAGES = 200

const EXTERNAL_REF_PREFIX = 'ghl_opp:'

/** Split a GHL contact into first/last, preferring structured fields. Pure. */
export function splitContactName(c: GhlContact | null): { first: string; last: string | null } {
  if (!c) return { first: 'Unknown', last: null }
  if (c.firstName || c.lastName) {
    return { first: c.firstName || c.lastName || 'Unknown', last: c.lastName || null }
  }
  const full = (c.name || c.contactName || '').trim()
  if (!full) return { first: 'Unknown', last: null }
  const parts = full.split(/\s+/)
  const [first, ...rest] = parts
  return { first, last: rest.length ? rest.join(' ') : null }
}

/** A stage move worth persisting: we have a new stage and it differs. Pure. */
export function stageChanged(existingStageId: string | null, newStageId: string | null): boolean {
  return newStageId != null && existingStageId !== newStageId
}

/** Map a GHL opportunity + resolved contact to a shared-ingest input. Pure. */
export function opportunityToIngestInput(
  opp: GhlOpportunity,
  contact: GhlContact | null,
  ctx: { organizationId: string; stageId: string | null; sourceName: string },
): IngestInput {
  const { first, last } = splitContactName(contact)
  return {
    organizationId: ctx.organizationId,
    firstName: first,
    lastName: last,
    email: contact?.email?.trim() || null,
    phoneRaw: contact?.phone?.trim() || null,
    source: ctx.sourceName,
    sourceType: 'ghl',
    externalRef: `${EXTERNAL_REF_PREFIX}${opp.id}`,
    tags: ['ghl'],
    stageId: ctx.stageId,
    // Consent earned later via the re-permission flow — nothing granted here.
    consent: { source: 'ghl_import' },
  }
}

type KnownRef = { leadId: string; stageId: string | null }

/** Load already-synced GHL opportunities for the org, keyed by opportunity id. */
export async function loadExistingGhlRefs(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<Map<string, KnownRef>> {
  const { data } = await supabase
    .from('leads')
    .select('id, external_ref, stage_id')
    .eq('organization_id', organizationId)
    .like('external_ref', `${EXTERNAL_REF_PREFIX}%`)

  const map = new Map<string, KnownRef>()
  for (const row of (data ?? []) as Array<{ id: string; external_ref: string | null; stage_id: string | null }>) {
    const ref = row.external_ref ?? ''
    if (!ref.startsWith(EXTERNAL_REF_PREFIX)) continue
    const oppId = ref.slice(EXTERNAL_REF_PREFIX.length)
    if (oppId) map.set(oppId, { leadId: row.id, stageId: row.stage_id ?? null })
  }
  return map
}

/** Merge a patch into the connector's `settings` JSON (watermark + last run stats). */
export async function updateGhlSyncState(
  supabase: SupabaseClient,
  organizationId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { data } = await supabase
    .from('connector_configs')
    .select('settings')
    .eq('organization_id', organizationId)
    .eq('connector_type', 'ghl')
    .maybeSingle()

  const settings = (data?.settings ?? {}) as Record<string, unknown>
  await supabase
    .from('connector_configs')
    .update({ settings: { ...settings, ...patch }, updated_at: new Date().toISOString() })
    .eq('organization_id', organizationId)
    .eq('connector_type', 'ghl')
}

/**
 * Run a full GHL → LI sync for one org. The caller supplies a service-role
 * client (RLS-bypassing) and the resolved config.
 */
export async function syncGhlLeads(
  supabase: SupabaseClient,
  organizationId: string,
  config: GhlConfig,
): Promise<GhlSyncResult> {
  const pipelines = await fetchPipelines(config)
  const targets = config.pipelineId
    ? pipelines.filter((p) => p.id === config.pipelineId)
    : pipelines

  const result: GhlSyncResult = {
    status: 'ok',
    pipelines: targets.length,
    fetched: 0,
    inserted: 0,
    deduplicated: 0,
    stageUpdated: 0,
    skipped: 0,
    noContact: 0,
  }

  if (targets.length === 0) {
    result.status = 'skipped'
    return result
  }

  const existing = await loadExistingGhlRefs(supabase, organizationId)

  for (const pipeline of targets) {
    const stageMap = await ensureStageMapping(supabase, organizationId, pipeline)

    for (let page = 1; page <= MAX_PAGES; page++) {
      const opps = await searchOpportunities(config, { pipelineId: pipeline.id, page })
      if (opps.length === 0) break

      for (const opp of opps) {
        result.fetched += 1
        const liStageId = opp.pipelineStageId ? stageMap[opp.pipelineStageId] ?? null : null
        const known = existing.get(opp.id)

        if (known) {
          if (stageChanged(known.stageId, liStageId)) {
            await supabase.from('leads').update({ stage_id: liStageId }).eq('id', known.leadId)
            await supabase.from('lead_activities').insert({
              organization_id: organizationId,
              lead_id: known.leadId,
              activity_type: 'stage_changed',
              title: 'Stage synced from GoHighLevel',
            })
            known.stageId = liStageId
            result.stageUpdated += 1
          } else {
            result.skipped += 1
          }
          continue
        }

        const contact = await resolveOpportunityContact(config, opp)
        if (!contact?.email?.trim() && !contact?.phone?.trim()) {
          result.noContact += 1
          continue
        }

        const input = opportunityToIngestInput(opp, contact, {
          organizationId,
          stageId: liStageId,
          sourceName: 'GoHighLevel',
        })
        const ingest = await ingestLead(supabase, input, { caller: 'ghl-sync', armSpeedToLead: false })
        if (ingest.deduplicated) result.deduplicated += 1
        else result.inserted += 1
        existing.set(opp.id, { leadId: ingest.id, stageId: liStageId })
        try {
          await ingest.runPostIngest()
        } catch {
          // post-ingest is best-effort; never fail the sync over it.
        }
      }

      if (opps.length < SEARCH_PAGE_SIZE) break
    }
  }

  await updateGhlSyncState(supabase, organizationId, {
    last_synced_at: new Date().toISOString(),
    last_run: {
      fetched: result.fetched,
      inserted: result.inserted,
      deduplicated: result.deduplicated,
      stageUpdated: result.stageUpdated,
      skipped: result.skipped,
      noContact: result.noContact,
    },
  })

  return result
}
