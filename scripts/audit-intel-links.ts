/**
 * Audit (and optionally repair) DGS `inbound_leads.intel_lead_id` → LI `leads.id`.
 *
 * WHY THIS EXISTS
 * ---------------
 * Dion Growth Studio stores the LI lead id it created on every row it pushes, and
 * the LI→DGS conversion writeback keys off it. Delete an LI lead — a duplicate
 * merge, a manual delete, a junk sweep — and that pointer dangles. Nothing errors:
 * the writeback simply stops landing for that lead, silently, forever. It
 * typically surfaces weeks later as "why did attribution stop working".
 *
 * The 2026-07-20 Messenger duplicate merge created 5 of these in one pass, which
 * is what prompted this script. ALWAYS run it after merging or bulk-deleting LI
 * leads.
 *
 * WHY A SCRIPT AND NOT SQL
 * ------------------------
 * LI and DGS are separate Supabase projects, so there is no join. This streams
 * both id sets locally (~59k + ~55k) and diffs them in memory.
 *
 * PROPOSED FIX, in priority order:
 *   1. LI `lead_identities` kind='dgs_lead_id'    value=inbound_leads.id
 *      — exact provenance: LI itself recorded that this DGS row is that lead.
 *   2. LI `lead_identities` kind='ghl_contact_id' value=inbound_leads.external_id
 *      — the GHL contact id, which is stable across DGS row churn.
 *
 * UNRESOLVABLE ROWS ARE LEFT ALONE — never nulled. `intel_lead_id` is then the
 * only surviving evidence the row ever reached LI, and a re-push can legitimately
 * recreate the link. Clearing it destroys that for no benefit. (At the 2026-07-20
 * audit all 19 unresolvable rows were WhatConverts staff/test calls pointing at
 * leads that had been deliberately deleted as junk — there was no correct
 * survivor to point at, by design.)
 *
 * Env (.env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Env (DGS, required): DGS_SUPABASE_URL, DGS_SUPABASE_SERVICE_ROLE_KEY
 *   — from the Dion Growth Studio project. Not needed by the app, only by this
 *     script, so they are read from the environment rather than .env.local.
 *
 * Usage:
 *   npx tsx scripts/audit-intel-links.ts          # dry-run: report only
 *   npx tsx scripts/audit-intel-links.ts --apply  # repair resolvable pointers
 */
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

config({ path: '.env.local' })

const APPLY = process.argv.includes('--apply')

type Dangling = {
  id: string
  name: string | null
  source: string | null
  externalId: string | null
  dead: string
  fix: string | null
  via: 'dgs_lead_id' | 'ghl_contact_id' | null
}

/** Page through a table, invoking `cb` per batch so nothing is held twice. */
async function scan<T>(
  client: SupabaseClient,
  table: string,
  columns: string,
  cb: (rows: T[]) => void,
  filter?: (q: any) => any,
): Promise<void> {
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    let q = client.from(table).select(columns).range(from, from + PAGE - 1).order('id')
    if (filter) q = filter(q)
    const { data, error } = await q
    if (error) throw new Error(`${table}: ${error.message}`)
    const rows = (data ?? []) as T[]
    if (!rows.length) return
    cb(rows)
    if (rows.length < PAGE) return
  }
}

async function main() {
  const liUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const liKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const dgsUrl = process.env.DGS_SUPABASE_URL
  const dgsKey = process.env.DGS_SUPABASE_SERVICE_ROLE_KEY
  if (!liUrl || !liKey) throw new Error('missing LI supabase env (.env.local)')
  if (!dgsUrl || !dgsKey) {
    throw new Error('missing DGS_SUPABASE_URL / DGS_SUPABASE_SERVICE_ROLE_KEY')
  }

  const LI = createClient(liUrl, liKey, { auth: { persistSession: false } })
  const DGS = createClient(dgsUrl, dgsKey, { auth: { persistSession: false } })

  console.log(`Mode: ${APPLY ? 'APPLY (repair resolvable pointers)' : 'DRY-RUN'}\n`)

  console.log('Loading LI lead ids…')
  const leadIds = new Set<string>()
  await scan<{ id: string }>(LI, 'leads', 'id', (rows) => rows.forEach((r) => leadIds.add(r.id)))
  console.log(`  ${leadIds.size.toLocaleString()} LI leads`)

  console.log('Loading LI identities…')
  const byDgsLead = new Map<string, string>()
  const byGhlContact = new Map<string, string>()
  await scan<{ lead_id: string; kind: string; value: string }>(
    LI,
    'lead_identities',
    'id, lead_id, kind, value',
    (rows) => {
      for (const r of rows) {
        if (r.kind === 'dgs_lead_id') byDgsLead.set(r.value, r.lead_id)
        else if (r.kind === 'ghl_contact_id') byGhlContact.set(r.value, r.lead_id)
      }
    },
  )
  console.log(
    `  ${byDgsLead.size.toLocaleString()} dgs_lead_id, ${byGhlContact.size.toLocaleString()} ghl_contact_id`,
  )

  console.log('Scanning DGS inbound_leads…')
  let total = 0
  const dangling: Dangling[] = []
  await scan<{
    id: string
    full_name: string | null
    source: string | null
    external_id: string | null
    intel_lead_id: string
  }>(
    DGS,
    'inbound_leads',
    'id, full_name, source, external_id, intel_lead_id',
    (rows) => {
      for (const r of rows) {
        total++
        if (leadIds.has(r.intel_lead_id)) continue
        const viaDgs = byDgsLead.get(r.id)
        const viaGhl = r.external_id ? byGhlContact.get(r.external_id) : undefined
        dangling.push({
          id: r.id,
          name: r.full_name,
          source: r.source,
          externalId: r.external_id,
          dead: r.intel_lead_id,
          fix: viaDgs ?? viaGhl ?? null,
          via: viaDgs ? 'dgs_lead_id' : viaGhl ? 'ghl_contact_id' : null,
        })
      }
    },
    (q) => q.not('intel_lead_id', 'is', null),
  )

  const fixable = dangling.filter((d) => d.fix)
  console.log(`\n  scanned            ${total.toLocaleString()}`)
  console.log(`  DANGLING           ${dangling.length.toLocaleString()}`)
  console.log(`  resolvable         ${fixable.length.toLocaleString()}`)
  console.log(`    via dgs_lead_id    ${fixable.filter((d) => d.via === 'dgs_lead_id').length}`)
  console.log(`    via ghl_contact_id ${fixable.filter((d) => d.via === 'ghl_contact_id').length}`)
  console.log(`  UNRESOLVABLE       ${(dangling.length - fixable.length).toLocaleString()} (left untouched by design)`)

  if (dangling.length) {
    console.log('\nsample:')
    for (const d of dangling.slice(0, 10)) {
      const target = d.fix ? `${d.fix.slice(0, 8)} via ${d.via}` : 'UNRESOLVED'
      console.log(`  ${d.name ?? '(no name)'} [${d.source}] dead=${d.dead.slice(0, 8)} -> ${target}`)
    }
  }

  if (!APPLY) {
    console.log('\n(dry run — pass --apply to repair)')
    return
  }
  if (!fixable.length) {
    console.log('\nNothing resolvable to apply.')
    return
  }

  console.log('\nApplying…')
  let ok = 0
  for (const d of fixable) {
    const { error } = await DGS.from('inbound_leads')
      .update({ intel_lead_id: d.fix })
      .eq('id', d.id)
    if (error) console.error(`  FAILED ${d.id}: ${error.message}`)
    else ok++
  }
  console.log(`  repaired ${ok.toLocaleString()} / ${fixable.length.toLocaleString()}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
