/**
 * One-off (idempotent, reversible): collapse duplicate `leads` that share a
 * phone number, created by the historical WhatConverts bulk backfill.
 *
 * WHY THIS EXISTS
 * ---------------
 * The live bridge intake (`/api/v1/leads`) already dedups on phone_hash, but an
 * early WhatConverts backfill inserted rows directly, bypassing it. Each row got
 * a DISTINCT external_ref (the WhatConverts lead id), so external-ref dedup never
 * caught them. Result: ~1,573 redundant rows across ~1,382 real people, ~244 of
 * whom showed up in two pipeline columns at once.
 *
 * WHY SOFT-MERGE (NOT DELETE)
 * ---------------------------
 * Losers carry `consent_log` rows, and consent_log is APPEND-ONLY (a BEFORE
 * DELETE/UPDATE trigger blocks both). Its FK from leads is ON DELETE CASCADE, so
 * hard-deleting a loser lead would trip the cascade into consent_log and be
 * rejected — the DB is deliberately built to never destroy a lead with consent
 * history. So we SOFT-merge: the loser is marked `disqualified` with
 * `disqualified_reason = 'duplicate: merged into <winner>'` and a
 * `custom_fields.merged_into` pointer. The existing pipeline board already hides
 * status in ('disqualified','lost') on sales stages, so losers drop off the board
 * with zero code changes, while every consent / enrichment / audit / activity row
 * stays intact and immutable under the original id.
 *
 * SELECTION
 * ---------
 *   • Only clusters where every row shares the SAME first+last name are touched.
 *     Multi-name clusters (a household sharing one phone) are LEFT ALONE.
 *   • Winner per cluster, in priority order:
 *       1. still ACTIVE (status not disqualified/lost)  ← learned the hard way:
 *          without this, an active lead can be merged into an already-dead row
 *       2. has real engagement (any message/sms in or out)
 *       3. has a GHL contact link
 *       4. has an analyzed conversation
 *       5. oldest, then lowest id (stable tiebreak)
 *
 * REVERSIBLE
 * ----------
 * Every loser's full pre-merge row is snapshotted into `leads_dedup_archive`
 * (jsonb + winner_id). `--restore` re-applies status / disqualified_reason / tags
 * / custom_fields from those snapshots.
 *
 * Usage:
 *   npx tsx scripts/dedup-whatconverts-leads.ts            # dry-run: analyze + write CSV
 *   npx tsx scripts/dedup-whatconverts-leads.ts --apply    # snapshot + soft-merge losers
 *   npx tsx scripts/dedup-whatconverts-leads.ts --restore  # undo: restore from archive
 * Env (.env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { writeFileSync } from 'node:fs'

const ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c' // SF Dentistry
const APPLY = process.argv.includes('--apply')
const RESTORE = process.argv.includes('--restore')
const CSV_PATH = 'scripts/dedup-whatconverts-leads.csv'
const DEAD = new Set(['disqualified', 'lost'])

type Lead = {
  id: string
  status: string | null
  phone_hash: string | null
  first_name: string | null
  last_name: string | null
  ghl_contact_id: string | null
  conversation_analyzed_at: string | null
  total_messages_received: number | null
  total_sms_received: number | null
  total_messages_sent: number | null
  total_sms_sent: number | null
  tags: string[] | null
  custom_fields: Record<string, unknown> | null
  disqualified_reason: string | null
  created_at: string
}

const nameKey = (l: Lead) =>
  `${(l.first_name ?? '').trim().toLowerCase()}|${(l.last_name ?? '').trim().toLowerCase()}`

// Lower is a better winner. Status-first — see header.
function winnerRank(l: Lead): [number, number, number, number, string, string] {
  const engaged =
    (l.total_messages_received ?? 0) + (l.total_sms_received ?? 0) +
    (l.total_messages_sent ?? 0) + (l.total_sms_sent ?? 0) > 0 ? 0 : 1
  return [
    DEAD.has(l.status ?? '') ? 1 : 0,
    engaged,
    l.ghl_contact_id ? 0 : 1,
    l.conversation_analyzed_at ? 0 : 1,
    l.created_at,
    l.id,
  ]
}
function cmpRank(a: Lead, b: Lead): number {
  const ra = winnerRank(a), rb = winnerRank(b)
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] < rb[i]) return -1
    if (ra[i] > rb[i]) return 1
  }
  return 0
}

type Supa = SupabaseClient

async function fetchAllDupLeads(supabase: Supa): Promise<Lead[]> {
  const cols =
    'id, status, phone_hash, first_name, last_name, ghl_contact_id, conversation_analyzed_at, ' +
    'total_messages_received, total_sms_received, total_messages_sent, total_sms_sent, ' +
    'tags, custom_fields, disqualified_reason, created_at'
  const out: Lead[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('leads').select(cols)
      .eq('organization_id', ORG_ID)
      .not('phone_hash', 'is', null).neq('phone_hash', '')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    out.push(...(data as unknown as Lead[]))
    if (data.length < PAGE) break
  }
  return out
}

function buildMapping(leads: Lead[]): { winner: Lead; losers: Lead[] }[] {
  const byPhone = new Map<string, Lead[]>()
  for (const l of leads) {
    if (!l.phone_hash) continue
    const arr = byPhone.get(l.phone_hash) ?? []
    arr.push(l); byPhone.set(l.phone_hash, arr)
  }
  const result: { winner: Lead; losers: Lead[] }[] = []
  for (const rows of byPhone.values()) {
    if (rows.length < 2) continue
    if (new Set(rows.map(nameKey)).size > 1) continue // household: leave alone
    const sorted = [...rows].sort(cmpRank)
    const losers = sorted.slice(1).filter((l) => !DEAD.has(l.status ?? '')) // already-dead need no merge
    if (losers.length) result.push({ winner: sorted[0], losers })
  }
  return result
}

async function restore(supabase: Supa) {
  const { data, error } = await supabase
    .from('leads_dedup_archive').select('lead').eq('reason', 'whatconverts_phone_dup')
  if (error) throw error
  let restored = 0
  for (const row of data ?? []) {
    const l = (row as { lead: Lead }).lead
    const { error: upErr } = await supabase.from('leads').update({
      status: l.status,
      disqualified_reason: l.disqualified_reason,
      tags: l.tags,
      custom_fields: l.custom_fields ?? {},
      updated_at: new Date().toISOString(),
    }).eq('id', l.id)
    if (upErr) throw upErr
    restored++
  }
  console.log(`Restored ${restored} leads from archive to their pre-merge state.`)
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  if (!url || !key) throw new Error('Missing Supabase env')
  const supabase: SupabaseClient = createClient(url, key, { auth: { persistSession: false } })

  if (RESTORE) { await restore(supabase); return }

  console.log(`Mode: ${APPLY ? 'APPLY (soft-merge, reversible via archive)' : 'DRY-RUN'}`)
  const leads = await fetchAllDupLeads(supabase)
  console.log(`Scanned ${leads.length} leads with a phone_hash.`)

  const mapping = buildMapping(leads)
  const winnerByLoser = new Map<string, string>()
  for (const m of mapping) for (const l of m.losers) winnerByLoser.set(l.id, m.winner.id)
  const loserIds = [...winnerByLoser.keys()]
  console.log(`Clusters to merge: ${mapping.length}  |  Loser rows: ${loserIds.length}`)

  // CSV of what will be soft-merged.
  const rows = [['loser_id', 'winner_id', 'name', 'loser_status', 'loser_created_at']]
  for (const m of mapping)
    for (const l of m.losers)
      rows.push([l.id, m.winner.id, `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim(), l.status ?? '', l.created_at])
  writeFileSync(CSV_PATH, rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'))
  console.log(`Wrote ${CSV_PATH} (${loserIds.length} rows).`)

  if (!APPLY) {
    console.log('\nDry-run only. Re-run with --apply to snapshot + soft-merge.')
    return
  }

  const BATCH = 200
  let merged = 0
  for (let i = 0; i < loserIds.length; i += BATCH) {
    const batch = loserIds.slice(i, i + BATCH)

    // 1. snapshot full loser rows (reversible)
    const { data: full, error: selErr } = await supabase.from('leads').select('*').in('id', batch)
    if (selErr) throw selErr
    const { error: arcErr } = await supabase.from('leads_dedup_archive').insert(
      (full ?? []).map((r) => ({
        reason: 'whatconverts_phone_dup',
        winner_id: winnerByLoser.get(String((r as { id: string }).id)) ?? null,
        lead: r,
      })),
    )
    if (arcErr) throw arcErr

    // 2. soft-merge each loser (board-hide via existing disqualified filter)
    for (const loserId of batch) {
      const winnerId = winnerByLoser.get(loserId)!
      const src = leads.find((l) => l.id === loserId)!
      const tags = Array.from(new Set([...(src.tags ?? []), 'duplicate', 'merged']))
      const { error: upErr } = await supabase.from('leads').update({
        status: 'disqualified',
        disqualified_reason: `duplicate: merged into ${winnerId}`,
        tags,
        custom_fields: { ...(src.custom_fields ?? {}), merged_into: winnerId, merge_reason: 'whatconverts_phone_dup' },
        updated_at: new Date().toISOString(),
      }).eq('id', loserId)
      if (upErr) throw upErr
      merged++
    }
    console.log(`  batch ${i / BATCH + 1}: soft-merged ${batch.length}`)
  }
  console.log(`\n✅ Done. Soft-merged ${merged} duplicate leads. Undo with --restore.`)
}

main().catch((err) => { console.error(err); process.exit(1) })
