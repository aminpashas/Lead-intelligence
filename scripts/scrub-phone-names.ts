/**
 * One-off (idempotent, reversible): null out phone numbers that were parsed into
 * the `first_name` / `last_name` columns of `leads`.
 *
 * WHY THIS EXISTS
 * ---------------
 * Upstream (GHL, and call-tracking via the DGS bridge) stores a contact's phone
 * number as its `name` when the contact arrives without one. Every importer we
 * have then split that "name" on whitespace, so the number landed in the two name
 * columns: first_name="(925)", last_name="497-0821". Every surface that shows a
 * lead name then showed a phone number — the leads table, pipeline cards, /tasks
 * titles ("Book (925) 497-0821 — ready, not scheduled") and, worst, AI SMS
 * personalization ("Hi (925),").
 *
 * The ingest guard (`src/lib/leads/phone-name.ts`, wired into `buildLeadInsert`
 * and the `/api/v1/leads` bridge route) stops NEW ones. This cleans up the
 * ~4,634 already in SF Dentistry.
 *
 * SELECTION — deliberately narrower than "looks numeric"
 * -----------------------------------------------------
 * Uses the SAME `scrubPhoneNames` classifier as the live ingest guard, so the
 * backfill and the guard can never disagree. Three cases:
 *   • both columns phone-shaped  → one split phone number; null both  (~4,542)
 *   • one column phone-shaped with >=7 digits, other is a real name
 *                                → null only the number, keep the name (~92)
 *   • anything else              → LEFT ALONE
 * That last case is the point: a false positive destroys a real patient's name
 * unrecoverably (the source row is upstream). Prod rows deliberately spared
 * include "Booth 14", "101 California", "Elias 111" and "Ns 113107".
 *
 * TAG
 * ---
 * Scrubbed leads get the `name-unknown` tag so the front desk can tell "we never
 * got a name" apart from "the name was lost", and so the affected cohort stays
 * queryable after the fact.
 *
 * REVERSIBLE
 * ----------
 * Every touched row's pre-scrub first_name/last_name/tags are snapshotted to
 * scripts/scrub-phone-names.snapshot.json BEFORE any write. `--restore` puts them
 * back verbatim.
 *
 * Usage:
 *   npx tsx scripts/scrub-phone-names.ts            # dry-run: report only, no writes
 *   npx tsx scripts/scrub-phone-names.ts --apply    # snapshot, then scrub
 *   npx tsx scripts/scrub-phone-names.ts --restore  # undo from snapshot
 * Env (.env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { scrubPhoneNames, NAME_UNKNOWN_TAG } from '../src/lib/leads/phone-name'

const ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c' // SF Dentistry
const APPLY = process.argv.includes('--apply')
const RESTORE = process.argv.includes('--restore')
const SNAPSHOT_PATH = 'scripts/scrub-phone-names.snapshot.json'
const PAGE = 1000

type Lead = {
  id: string
  first_name: string | null
  last_name: string | null
  tags: string[] | null
  source_type: string | null
}

type Snapshot = {
  taken_at: string
  org_id: string
  rows: Array<Pick<Lead, 'id' | 'first_name' | 'last_name' | 'tags'>>
}

function client() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) { console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }
  return createClient(url, key, { auth: { persistSession: false } })
}

/** Page through every lead in the org — names are plaintext here, so the
 *  classifier can run client-side without touching the encryption keys. */
async function fetchAll(supabase: ReturnType<typeof client>): Promise<Lead[]> {
  const out: Lead[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('leads')
      .select('id, first_name, last_name, tags, source_type')
      .eq('organization_id', ORG_ID)
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    if (!data?.length) break
    out.push(...(data as Lead[]))
    if (data.length < PAGE) break
  }
  return out
}

async function restore() {
  if (!existsSync(SNAPSHOT_PATH)) { console.error(`No snapshot at ${SNAPSHOT_PATH}`); process.exit(1) }
  const snap: Snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'))
  const supabase = client()
  console.log(`Restoring ${snap.rows.length} leads from snapshot taken ${snap.taken_at}...`)
  let done = 0
  for (const row of snap.rows) {
    const { error } = await supabase
      .from('leads')
      .update({ first_name: row.first_name, last_name: row.last_name, tags: row.tags })
      .eq('id', row.id)
    if (error) { console.error(`  ${row.id}: ${error.message}`); continue }
    if (++done % 500 === 0) console.log(`  ${done}/${snap.rows.length}`)
  }
  console.log(`Restored ${done}/${snap.rows.length}.`)
}

async function main() {
  if (RESTORE) return restore()

  const supabase = client()
  console.log(`Mode: ${APPLY ? 'APPLY (reversible via snapshot)' : 'DRY-RUN (no writes)'}`)
  const leads = await fetchAll(supabase)
  console.log(`Scanned ${leads.length} leads in SF Dentistry.\n`)

  const planned = leads
    .map((lead) => ({ lead, verdict: scrubPhoneNames({ first: lead.first_name, last: lead.last_name }) }))
    .filter(({ verdict }) => verdict.changed)

  // Report by shape so the blast radius is legible before anything is written.
  const bothNulled = planned.filter((p) => !p.verdict.first && !p.verdict.last)
  const firstKept = planned.filter((p) => p.verdict.first && !p.verdict.last)
  const lastKept = planned.filter((p) => !p.verdict.first && p.verdict.last)
  const bySource = new Map<string, number>()
  for (const p of planned) {
    const s = p.lead.source_type ?? '(null)'
    bySource.set(s, (bySource.get(s) ?? 0) + 1)
  }

  console.log('--- Plan ---')
  console.log(`  split phone, null both:      ${bothNulled.length}`)
  console.log(`  keep first, null last:       ${firstKept.length}`)
  console.log(`  null first, keep last:       ${lastKept.length}`)
  console.log(`  TOTAL to scrub:              ${planned.length}`)
  console.log('\n--- By source ---')
  for (const [s, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(6)}  ${s}`)
  }
  console.log('\n--- Sample (first 10) ---')
  for (const { lead, verdict } of planned.slice(0, 10)) {
    const before = `${lead.first_name ?? '∅'} | ${lead.last_name ?? '∅'}`
    const after = `${verdict.first ?? '∅'} | ${verdict.last ?? '∅'}`
    console.log(`  ${before}  →  ${after}`)
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to scrub.')
    return
  }

  // Snapshot BEFORE any write, so --restore is always possible.
  const snapshot: Snapshot = {
    taken_at: new Date().toISOString(),
    org_id: ORG_ID,
    rows: planned.map(({ lead }) => ({
      id: lead.id, first_name: lead.first_name, last_name: lead.last_name, tags: lead.tags,
    })),
  }
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2))
  console.log(`\nSnapshotted ${snapshot.rows.length} rows → ${SNAPSHOT_PATH}`)

  console.log('Scrubbing...')
  let done = 0, errors = 0
  for (const { lead, verdict } of planned) {
    const tags = (lead.tags ?? []).includes(NAME_UNKNOWN_TAG)
      ? lead.tags
      : [...(lead.tags ?? []), NAME_UNKNOWN_TAG]
    const { error } = await supabase
      .from('leads')
      // `first_name` is NOT NULL — '' is how the schema spells "no name".
      .update({ first_name: verdict.first ?? '', last_name: verdict.last, tags })
      .eq('id', lead.id)
    if (error) { errors += 1; console.error(`  ${lead.id}: ${error.message}`); continue }
    if (++done % 500 === 0) console.log(`  ${done}/${planned.length}`)
  }
  console.log(`\nScrubbed ${done}/${planned.length} (${errors} errors).`)
  console.log(`Undo with: npx tsx ${process.argv[1]?.split('/').slice(-2).join('/')} --restore`)
}

main().catch((e) => { console.error(e); process.exit(1) })
