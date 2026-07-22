/**
 * One-off (idempotent, reversible): put patients' real names back on leads that
 * lost them, by asking the systems that still know.
 *
 * WHY THIS EXISTS
 * ---------------
 * ~4,600 SF Dentistry leads have an empty `first_name`. Very few were nameless
 * at capture. Upstream (GHL, and call tracking via the DGS bridge) writes a
 * contact's PHONE into its `name` field when it has nothing better; every
 * importer split that on whitespace into the two name columns; and
 * `scrub-phone-names.ts` then correctly nulled them rather than keep texting
 * patients "Hi (925),". Correct, but lossy — the scrub could not ask the source
 * what the patient is actually called.
 *
 * The visible cost lands on /tasks, where the queue reads "Book Unknown — ready,
 * not scheduled" and "Re-engage -408 724-0003 — gone quiet" instead of naming a
 * patient the front desk is about to phone.
 *
 * SOURCES, in trust order
 * -----------------------
 *   1. `patients` — the CareStack roster, ALREADY mirrored into our own DB by
 *      the EHR sync and linked to the lead. A human typed these at the front
 *      desk, and no API call is needed: it is a join we simply never made.
 *   2. GHL contact behind the lead's `ghl_opp:<id>` external_ref. One
 *      opportunity fetch + one contact fetch per lead, so this is the slow,
 *      rate-limited half — bound it with `--limit`, and it is OFF by default.
 *
 * Leads whose `external_ref` is a bare UUID came through the DGS bridge
 * (`inbound_leads.id`), not GHL, and are not reachable from here — they are
 * reported as `unreachable` rather than silently counted as failures.
 *
 * MEASURED YIELD (SF Dentistry, 2026-07-22, 4,617 nameless leads)
 * --------------------------------------------------------------
 *   CareStack : 285 / 285 linked patients → 285 names.   Free, instant.
 *   GHL       :   1 / 200 sampled          → ~0.5%.      ~2 API calls each.
 *
 * That GHL number is not a bug and was verified by hand against the live API:
 * GHL is WHERE THE PROBLEM COMES FROM. Its contacts for these leads either hold
 * no name at all (`name: ""`, no firstName/lastName) or hold the phone number
 * itself — one real prod contact is stored as `firstName: "(415)",
 * lastName: "488-4741"`. `recoverLeadName` correctly refuses that, which is the
 * guard doing its job, not a miss. So: run the CareStack pass, and treat `--ghl`
 * as a ~11-minute sweep over 2,662 leads for roughly a dozen names.
 *
 * THE ONE RULE THAT MATTERS
 * -------------------------
 * Never write a phone number back into a name column — that is the exact defect
 * the scrub was run to fix, and upstream `name` fields are where those phone
 * numbers came from in the first place. Every candidate goes through
 * `recoverLeadName`, which runs the SAME `scrubPhoneNames` classifier as the
 * live ingest guard, so recovery and prevention can never disagree.
 *
 * Recovered leads also drop the `name-unknown` tag, which means "we never got a
 * name" and is no longer true of them.
 *
 * REVERSIBLE
 * ----------
 * Every touched row's pre-backfill first_name/last_name/tags are snapshotted to
 * scripts/backfill-lead-names.snapshot.json BEFORE any write. `--restore` puts
 * them back verbatim.
 *
 * Usage:
 *   npx tsx scripts/backfill-lead-names.ts                  # dry-run, local sources only
 *   npx tsx scripts/backfill-lead-names.ts --ghl            # dry-run, also query GHL
 *   npx tsx scripts/backfill-lead-names.ts --ghl --limit 50 # cap the GHL fetches
 *   npx tsx scripts/backfill-lead-names.ts --apply          # snapshot, then write
 *   npx tsx scripts/backfill-lead-names.ts --restore        # undo from snapshot
 * Env (.env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { recoverLeadName, type NameCandidate, type RecoveredName } from '../src/lib/leads/recover-name'
import { NAME_UNKNOWN_TAG } from '../src/lib/leads/phone-name'
import { getGhlConfig, getOpportunity, getContact } from '../src/lib/ghl/client'

const ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c' // SF Dentistry
const APPLY = process.argv.includes('--apply')
const RESTORE = process.argv.includes('--restore')
const USE_GHL = process.argv.includes('--ghl')
const SNAPSHOT_PATH = 'scripts/backfill-lead-names.snapshot.json'
const GHL_PREFIX = 'ghl_opp:'
const PAGE = 1000

/** Politeness delay between GHL round-trips. `ghlFetch` already retries once on
 *  429; this keeps us from leaning on that for thousands of sequential reads. */
const GHL_DELAY_MS = 120

function argValue(flag: string): number | null {
  const i = process.argv.indexOf(flag)
  if (i === -1 || !process.argv[i + 1]) return null
  const n = Number(process.argv[i + 1])
  return Number.isFinite(n) ? n : null
}
const GHL_LIMIT = argValue('--limit') ?? Infinity

type Lead = {
  id: string
  first_name: string | null
  last_name: string | null
  tags: string[] | null
  external_ref: string | null
}

type Snapshot = {
  taken_at: string
  org_id: string
  rows: Array<Pick<Lead, 'id' | 'first_name' | 'last_name' | 'tags'>>
}

type Plan = { lead: Lead; recovered: RecoveredName }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function client() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
    process.exit(1)
  }
  return createClient(url, key, { auth: { persistSession: false } })
}
type Db = ReturnType<typeof client>

/**
 * Every lead in the org with no name at all.
 *
 * `first_name` is NOT NULL and spells "no name" as the empty string, so this
 * matches on '' — filtering for null finds nothing at all. `last_name` IS
 * nullable, hence the two-branch `or`. Verified against prod 2026-07-22: this
 * returns 4,617, the same count as the equivalent SQL.
 */
async function fetchNameless(supabase: Db): Promise<Lead[]> {
  const out: Lead[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('leads')
      .select('id, first_name, last_name, tags, external_ref')
      .eq('organization_id', ORG_ID)
      .eq('first_name', '')
      .or('last_name.is.null,last_name.eq.')
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    if (!data?.length) break
    out.push(...(data as Lead[]))
    if (data.length < PAGE) break
  }
  return out
}

/** CareStack names already sitting in our own `patients` table, by lead_id. */
async function fetchPatientNames(
  supabase: Db,
  leadIds: string[]
): Promise<Map<string, NameCandidate>> {
  const byLead = new Map<string, NameCandidate>()
  // 100 ids per request, not 500: `.in()` goes into the query string, and 500
  // UUIDs overflowed the URL length limit — which surfaced as a bare
  // "TypeError: fetch failed", not a readable PostgREST error.
  for (let i = 0; i < leadIds.length; i += 100) {
    const { data, error } = await supabase
      .from('patients')
      .select('lead_id, first_name, last_name')
      .eq('organization_id', ORG_ID)
      .in('lead_id', leadIds.slice(i, i + 100))
    if (error) throw new Error(error.message)
    for (const row of (data ?? []) as Array<{
      lead_id: string | null
      first_name: string | null
      last_name: string | null
    }>) {
      if (!row.lead_id || byLead.has(row.lead_id)) continue
      byLead.set(row.lead_id, {
        source: 'carestack',
        first: row.first_name,
        last: row.last_name,
      })
    }
  }
  return byLead
}

/** Walk lead → GHL opportunity → GHL contact. Best-effort per lead. */
async function fetchGhlName(
  ghlConfig: Awaited<ReturnType<typeof getGhlConfig>>,
  externalRef: string
): Promise<NameCandidate | null> {
  if (!ghlConfig) return null
  const opp = await getOpportunity(ghlConfig, externalRef.slice(GHL_PREFIX.length))
  if (!opp) return null

  // The inline contact on an opportunity is a summary and often omits the name
  // split, so prefer the full contact record and fall back to inline.
  const contactId = opp.contactId || opp.contact?.id
  const contact = contactId ? await getContact(ghlConfig, contactId) : null
  const best = contact ?? opp.contact
  if (!best) return null

  return {
    source: 'ghl',
    first: best.firstName,
    last: best.lastName,
    full: best.name || best.contactName || opp.name,
  }
}

async function restore() {
  if (!existsSync(SNAPSHOT_PATH)) {
    console.error(`No snapshot at ${SNAPSHOT_PATH}`)
    process.exit(1)
  }
  const snap: Snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'))
  const supabase = client()
  console.log(`Restoring ${snap.rows.length} leads from snapshot taken ${snap.taken_at}...`)
  let done = 0
  for (const row of snap.rows) {
    const { error } = await supabase
      .from('leads')
      .update({ first_name: row.first_name, last_name: row.last_name, tags: row.tags })
      .eq('id', row.id)
    if (error) {
      console.error(`  ${row.id}: ${error.message}`)
      continue
    }
    if (++done % 500 === 0) console.log(`  ${done}/${snap.rows.length}`)
  }
  console.log(`Restored ${done}/${snap.rows.length}.`)
}

async function main() {
  if (RESTORE) return restore()

  const supabase = client()
  console.log(`Mode: ${APPLY ? 'APPLY (reversible via snapshot)' : 'DRY-RUN (no writes)'}`)
  console.log(`GHL:  ${USE_GHL ? `enabled (limit ${GHL_LIMIT})` : 'skipped (pass --ghl to enable)'}\n`)

  const leads = await fetchNameless(supabase)
  console.log(`Found ${leads.length} nameless leads in SF Dentistry.`)

  // ── Source 1: the CareStack roster we already hold ────────────────────
  const patientNames = await fetchPatientNames(supabase, leads.map((l) => l.id))
  console.log(`  ${patientNames.size} have a linked CareStack patient row.`)

  const plans: Plan[] = []
  const stillNameless: Lead[] = []
  for (const lead of leads) {
    const candidate = patientNames.get(lead.id)
    const recovered = candidate ? recoverLeadName([candidate]) : null
    if (recovered) plans.push({ lead, recovered })
    else stillNameless.push(lead)
  }
  console.log(`  → ${plans.length} names recovered from CareStack.\n`)

  // ── Source 2: GHL, one round-trip per lead ────────────────────────────
  const ghlCandidates = stillNameless.filter((l) => l.external_ref?.startsWith(GHL_PREFIX))
  const unreachable = stillNameless.length - ghlCandidates.length
  console.log(`${ghlCandidates.length} remaining leads have a GHL opportunity ref.`)
  console.log(`${unreachable} have no GHL ref (DGS-bridge leads) — not reachable from here.`)

  if (USE_GHL) {
    const ghlConfig = await getGhlConfig(supabase, ORG_ID)
    if (!ghlConfig) {
      console.log('  GHL connector not configured/enabled for this org — skipping.\n')
    } else {
      const batch = ghlCandidates.slice(0, GHL_LIMIT)
      console.log(`  Querying GHL for ${batch.length}...`)
      let found = 0
      for (const [i, lead] of batch.entries()) {
        const candidate = await fetchGhlName(ghlConfig, lead.external_ref!)
        const recovered = candidate ? recoverLeadName([candidate]) : null
        if (recovered) {
          plans.push({ lead, recovered })
          found++
        }
        if ((i + 1) % 100 === 0) console.log(`    ${i + 1}/${batch.length} (${found} found)`)
        await sleep(GHL_DELAY_MS)
      }
      console.log(`  → ${found} names recovered from GHL.\n`)
    }
  } else {
    console.log('')
  }

  // ── Report ────────────────────────────────────────────────────────────
  const bySource = new Map<string, number>()
  for (const p of plans) bySource.set(p.recovered.source, (bySource.get(p.recovered.source) ?? 0) + 1)
  console.log(`TOTAL recoverable: ${plans.length}`)
  for (const [source, n] of bySource) console.log(`  ${source}: ${n}`)
  console.log('\nSample:')
  for (const p of plans.slice(0, 10)) {
    const name = [p.recovered.first, p.recovered.last].filter(Boolean).join(' ')
    console.log(`  ${p.lead.id}  ←  "${name}"  (${p.recovered.source})`)
  }

  if (!APPLY) {
    console.log('\nDry-run: nothing written. Re-run with --apply to write.')
    return
  }
  if (plans.length === 0) {
    console.log('\nNothing to write.')
    return
  }

  // Snapshot BEFORE any write, so --restore is always available.
  const snapshot: Snapshot = {
    taken_at: new Date().toISOString(),
    org_id: ORG_ID,
    rows: plans.map(({ lead }) => ({
      id: lead.id,
      first_name: lead.first_name,
      last_name: lead.last_name,
      tags: lead.tags,
    })),
  }
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2))
  console.log(`\nSnapshot written to ${SNAPSHOT_PATH} (${snapshot.rows.length} rows).`)

  let done = 0
  for (const { lead, recovered } of plans) {
    // `first_name` is NOT NULL — '' is how the schema spells "no name", which is
    // still the honest value when only a surname was recovered.
    const tags = (lead.tags ?? []).filter((t) => t !== NAME_UNKNOWN_TAG)
    const { error } = await supabase
      .from('leads')
      .update({ first_name: recovered.first ?? '', last_name: recovered.last, tags })
      .eq('id', lead.id)
    if (error) {
      console.error(`  ${lead.id}: ${error.message}`)
      continue
    }
    if (++done % 250 === 0) console.log(`  ${done}/${plans.length}`)
  }
  console.log(`\nUpdated ${done}/${plans.length} leads.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
