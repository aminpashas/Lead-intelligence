/**
 * Reversible soft-merge of a duplicate lead into a surviving one.
 *
 * WHY SOFT, NOT DELETE: the database is built to never destroy a lead that
 * carries consent history — `consent_log` has an ON DELETE CASCADE FK to leads
 * and an append-only BEFORE-DELETE trigger, so a hard delete is refused. Keeping
 * the loser row also keeps DGS's `inbound_leads.intel_lead_id` (and the LI→DGS
 * conversion writeback) valid. So a merge never deletes: the loser becomes a
 * tombstone — disqualified, its contact keys cleared, a `merged_into` pointer to
 * the winner — and its full pre-merge state is snapshotted to
 * `leads_dedup_archive` so the merge can be undone.
 *
 * WHAT MOVES: the timeline the winner should now own — conversations, messages,
 * appointments, activities — plus `lead_identities` (so a FUTURE inbound event
 * on any of the loser's correlation ids dedups onto the winner). Analytics and
 * composite-unique child rows (campaign_enrollments, lead_tags, technique
 * tracking, …) stay attached to the preserved loser row; that is safe because
 * the row still exists.
 *
 * WHY CLEAR THE LOSER'S CONTACT HASHES: `findExistingLeads` (lib/leads/dedupe.ts)
 * resolves an inbound by phone_hash / email_hash and takes whichever row comes
 * back first — it does NOT skip disqualified rows. If the tombstone kept its
 * hashes it could still steal a future message. So the merge nulls the loser's
 * contact (preserved in the snapshot) and backfills any field the winner was
 * missing, making the winner the single reachable record.
 *
 * See [[leads-phone-dup-softmerge]], [[lead-identities-social-dedup]].
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { encryptLeadPII } from '@/lib/encryption'
import { auditPHIWrite } from '@/lib/hipaa-audit'
import { logger } from '@/lib/logger'

/** Child tables whose rows follow the person onto the winning record. */
const TIMELINE_TABLES = ['conversations', 'messages', 'appointments', 'lead_activities'] as const

export type MergeActor = { userId: string | null; source: string }

export type MergeInput = {
  organizationId: string
  /** The surviving canonical lead. */
  winnerId: string
  /** The duplicate that becomes a tombstone pointing at the winner. */
  loserId: string
  actor: MergeActor
  reason?: string
}

export type MergeResult = {
  archiveId: string
  winnerId: string
  loserId: string
  /** Rows moved per table, plus which winner fields were backfilled. */
  moved: Record<string, number>
}

type LeadRow = Record<string, unknown> & {
  id: string
  organization_id: string
  email: string | null
  phone: string | null
  phone_formatted: string | null
  email_hash: string | null
  phone_hash: string | null
  status: string | null
  tags: string[] | null
  custom_fields: Record<string, unknown> | null
}

export class MergeError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'same_lead' | 'already_merged' | 'failed',
  ) {
    super(message)
    this.name = 'MergeError'
  }
}

async function loadLead(
  supabase: SupabaseClient,
  orgId: string,
  id: string,
): Promise<LeadRow | null> {
  const { data } = await supabase
    .from('leads')
    .select('*')
    .eq('id', id)
    .eq('organization_id', orgId)
    .maybeSingle()
  return (data as LeadRow | null) ?? null
}

function isMergedAway(lead: LeadRow): boolean {
  return Boolean(lead.custom_fields && lead.custom_fields.merged_into)
}

/**
 * Merge `loserId` into `winnerId`. Idempotency-guarded: a loser already merged
 * away, a winner that is itself a tombstone, or winner === loser all throw a
 * typed `MergeError` the caller maps to a 4xx.
 */
export async function mergeLeads(
  supabase: SupabaseClient,
  input: MergeInput,
): Promise<MergeResult> {
  const { organizationId: orgId, winnerId, loserId, actor } = input

  if (winnerId === loserId) {
    throw new MergeError('Cannot merge a lead into itself', 'same_lead')
  }

  const [winner, loser] = await Promise.all([
    loadLead(supabase, orgId, winnerId),
    loadLead(supabase, orgId, loserId),
  ])

  if (!winner) throw new MergeError('Surviving lead not found', 'not_found')
  if (!loser) throw new MergeError('Duplicate lead not found', 'not_found')
  if (isMergedAway(loser)) {
    throw new MergeError('That duplicate has already been merged', 'already_merged')
  }
  if (isMergedAway(winner)) {
    // Merging into a tombstone would chain pointers and hide the real winner.
    throw new MergeError('The surviving lead is itself a merged duplicate', 'already_merged')
  }

  const now = new Date().toISOString()
  const moved: Record<string, number> = {}
  const movedIds: Record<string, string[]> = {}

  // 1. Snapshot the loser BEFORE any mutation, so the archive is a faithful
  //    pre-merge copy that an un-merge can restore verbatim.
  const { data: archive, error: archiveErr } = await supabase
    .from('leads_dedup_archive')
    .insert({
      organization_id: orgId,
      loser_lead_id: loserId,
      winner_lead_id: winnerId,
      reason: input.reason ?? 'manual_merge',
      lead: loser,
      merged_by: actor.userId,
    })
    .select('id')
    .single()

  if (archiveErr || !archive) {
    throw new MergeError(
      `Could not snapshot the duplicate before merging: ${archiveErr?.message ?? 'unknown'}`,
      'failed',
    )
  }
  const archiveId = String(archive.id)

  // 2. Move the timeline onto the winner, recording the exact ids so the merge
  //    is precisely reversible.
  for (const table of TIMELINE_TABLES) {
    try {
      const { data: rows } = await supabase
        .from(table)
        .select('id')
        .eq('organization_id', orgId)
        .eq('lead_id', loserId)
      const ids = (rows ?? []).map((r) => String((r as { id: string }).id))
      if (ids.length) {
        await supabase
          .from(table)
          .update({ lead_id: winnerId })
          .eq('organization_id', orgId)
          .eq('lead_id', loserId)
        movedIds[table] = ids
        moved[table] = ids.length
      }
    } catch (e) {
      // Best-effort per table: a single table failing must not leave the merge
      // half-done in a way that can't be reversed — the snapshot already exists.
      logger.error('lead merge: repoint failed', {
        table,
        loserId,
        winnerId,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  // 3. lead_identities: union onto the winner, then strip the loser. The unique
  //    index is (org, kind, value) EXCLUDING lead_id, so re-attaching to the
  //    winner is an upsert-ignore; then the loser's rows are deleted (repointed,
  //    never left to cascade-delete — the CASCADE would destroy the very keys
  //    that prevent the next duplicate).
  try {
    const { data: loserIdentities } = await supabase
      .from('lead_identities')
      .select('kind, value')
      .eq('organization_id', orgId)
      .eq('lead_id', loserId)

    if (loserIdentities?.length) {
      await supabase.from('lead_identities').upsert(
        loserIdentities.map((i) => ({
          organization_id: orgId,
          lead_id: winnerId,
          kind: (i as { kind: string }).kind,
          value: (i as { value: string }).value,
        })),
        { onConflict: 'organization_id,kind,value', ignoreDuplicates: true },
      )
      await supabase
        .from('lead_identities')
        .delete()
        .eq('organization_id', orgId)
        .eq('lead_id', loserId)
      movedIds.lead_identities = loserIdentities.map(
        (i) => `${(i as { kind: string }).kind}:${(i as { value: string }).value}`,
      )
      moved.lead_identities = loserIdentities.length
    }
  } catch (e) {
    logger.error('lead merge: identity repoint failed', {
      loserId,
      winnerId,
      error: e instanceof Error ? e.message : String(e),
    })
  }

  // 4. Backfill any contact field the winner lacks, so the winner is the single
  //    reachable record. encryptLeadPII re-derives the search hashes.
  const backfill: Record<string, unknown> = {}
  if (!winner.email && loser.email) backfill.email = loser.email
  if (!winner.phone && loser.phone) {
    backfill.phone = loser.phone
    if (loser.phone_formatted) backfill.phone_formatted = loser.phone_formatted
  }
  const backfilledFields = Object.keys(backfill)
  if (backfilledFields.length) {
    try {
      await supabase
        .from('leads')
        .update(encryptLeadPII(backfill))
        .eq('id', winnerId)
        .eq('organization_id', orgId)
      moved.backfilled = backfilledFields.length
    } catch (e) {
      // A unique-email collision means a THIRD duplicate owns that address —
      // skip the backfill rather than fail the merge; the value is in the
      // snapshot and the winner keeps its own contact.
      logger.error('lead merge: winner backfill skipped', {
        winnerId,
        fields: backfilledFields,
        error: e instanceof Error ? e.message : String(e),
      })
      backfilledFields.length = 0
    }
  }

  // 5. Tombstone the loser: clear its contact keys (so it can't steal a future
  //    inbound), point it at the winner, and disqualify it (drops off the board).
  const loserTags = Array.isArray(loser.tags) ? loser.tags : []
  const tombstoneTags = Array.from(new Set([...loserTags, 'duplicate', 'merged']))
  const loserCustom = (loser.custom_fields as Record<string, unknown> | null) ?? {}

  const { error: tombErr } = await supabase
    .from('leads')
    .update({
      status: 'disqualified',
      disqualified_reason: `duplicate: merged into ${winnerId}`,
      email: null,
      email_hash: null,
      phone: null,
      phone_formatted: null,
      phone_hash: null,
      tags: tombstoneTags,
      custom_fields: {
        ...loserCustom,
        merged_into: winnerId,
        merged_at: now,
        dedup_archive_id: archiveId,
      },
    })
    .eq('id', loserId)
    .eq('organization_id', orgId)

  if (tombErr) {
    throw new MergeError(`Could not finalize the merge: ${tombErr.message}`, 'failed')
  }

  // Record what moved (for the audit trail and a faithful un-merge).
  await supabase
    .from('leads_dedup_archive')
    .update({ moved: { ...movedIds, backfilled: backfilledFields } })
    .eq('id', archiveId)

  // 6. Winner timeline entry + HIPAA audit on both records.
  await supabase.from('lead_activities').insert({
    organization_id: orgId,
    lead_id: winnerId,
    activity_type: 'merged',
    title: 'Duplicate lead merged in',
    description: `Consolidated duplicate ${loserId} into this record`,
    metadata: { loser_lead_id: loserId, archive_id: archiveId, moved },
  })

  auditPHIWrite(
    { supabase, organizationId: orgId, actorType: 'user', actorId: actor.userId ?? actor.source },
    'lead',
    winnerId,
    `Merged duplicate lead ${loserId} into ${winnerId}`,
  )

  return { archiveId, winnerId, loserId, moved }
}

/**
 * Reverse a merge from its archive row: move the timeline back, restore the
 * loser's identities and pre-merge lead state, and mark the archive restored.
 * Idempotent — a row already restored is a no-op.
 */
export async function unmergeLeads(
  supabase: SupabaseClient,
  input: { organizationId: string; archiveId: string; actor: MergeActor },
): Promise<{ loserId: string; winnerId: string }> {
  const { organizationId: orgId, archiveId, actor } = input

  const { data: archive } = await supabase
    .from('leads_dedup_archive')
    .select('*')
    .eq('id', archiveId)
    .eq('organization_id', orgId)
    .maybeSingle()

  if (!archive) throw new MergeError('Merge record not found', 'not_found')
  const row = archive as {
    loser_lead_id: string
    winner_lead_id: string
    lead: LeadRow
    moved: Record<string, string[]> | null
    restored_at: string | null
  }
  if (row.restored_at) {
    return { loserId: row.loser_lead_id, winnerId: row.winner_lead_id }
  }

  const loserId = row.loser_lead_id
  const winnerId = row.winner_lead_id
  const moved = row.moved ?? {}

  // Move the recorded child rows back to the loser by their exact ids.
  for (const table of TIMELINE_TABLES) {
    const ids = moved[table]
    if (ids?.length) {
      await supabase
        .from(table)
        .update({ lead_id: loserId })
        .eq('organization_id', orgId)
        .in('id', ids)
    }
  }

  // Restore the loser's identities (best-effort; winner keeps any it also held).
  const identityKeys = moved.lead_identities ?? []
  if (identityKeys.length) {
    await supabase.from('lead_identities').upsert(
      identityKeys.map((k) => {
        const idx = k.indexOf(':')
        return {
          organization_id: orgId,
          lead_id: loserId,
          kind: k.slice(0, idx),
          value: k.slice(idx + 1),
        }
      }),
      { onConflict: 'organization_id,kind,value', ignoreDuplicates: true },
    )
  }

  // Restore the loser lead row from the snapshot (contact keys, status, tags,
  // custom_fields — everything the tombstone overwrote).
  const snap = row.lead
  await supabase
    .from('leads')
    .update({
      status: snap.status,
      disqualified_reason: (snap as { disqualified_reason?: string | null }).disqualified_reason ?? null,
      email: snap.email,
      email_hash: snap.email_hash,
      phone: snap.phone,
      phone_formatted: snap.phone_formatted,
      phone_hash: snap.phone_hash,
      tags: snap.tags,
      custom_fields: snap.custom_fields ?? {},
    })
    .eq('id', loserId)
    .eq('organization_id', orgId)

  await supabase
    .from('leads_dedup_archive')
    .update({ restored_at: new Date().toISOString(), restored_by: actor.userId })
    .eq('id', archiveId)

  auditPHIWrite(
    { supabase, organizationId: orgId, actorType: 'user', actorId: actor.userId ?? actor.source },
    'lead',
    loserId,
    `Un-merged duplicate lead ${loserId} from ${winnerId}`,
  )

  return { loserId, winnerId }
}
