/**
 * Shared pure helpers for the GoHighLevel inbound integration.
 *
 * The reconciliation engine itself lives in `src/lib/ghl/reconcile.ts` (used by
 * both the nightly cron and the manual "Sync now" trigger). These small, pure
 * helpers — contact-name splitting, stage-change detection, and mapping an
 * opportunity into the shared ingest shape — are kept here because they are
 * unit-tested in isolation and reused when a synced opportunity has to be
 * ingested as a brand-new lead.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { IngestInput } from '@/lib/leads/ingest'
import type { GhlContact, GhlOpportunity } from './types'

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

/** Load already-synced GHL opportunities for the org, keyed by opportunity id. */
export async function loadExistingGhlRefs(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<Map<string, { leadId: string; stageId: string | null }>> {
  const { data } = await supabase
    .from('leads')
    .select('id, external_ref, stage_id')
    .eq('organization_id', organizationId)
    .like('external_ref', `${EXTERNAL_REF_PREFIX}%`)

  const map = new Map<string, { leadId: string; stageId: string | null }>()
  for (const row of (data ?? []) as Array<{ id: string; external_ref: string | null; stage_id: string | null }>) {
    const ref = row.external_ref ?? ''
    if (!ref.startsWith(EXTERNAL_REF_PREFIX)) continue
    const oppId = ref.slice(EXTERNAL_REF_PREFIX.length)
    if (oppId) map.set(oppId, { leadId: row.id, stageId: row.stage_id ?? null })
  }
  return map
}
