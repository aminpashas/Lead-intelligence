/**
 * Sync the `closing_book` table from the practice's "Case Follow ups" sheet.
 *
 * The board at /closing renders `closing_book`, a curated list the practice
 * maintains by hand in a spreadsheet. That sheet drifts daily; this script
 * reconciles the table to it (idempotent: insert new patients, update case
 * value / status / won / last-contact, delete patients who left the sheet).
 * In-app edits (temperature override, next step) are preserved — see
 * src/lib/pipeline/closing-book-sync.ts for the ownership rule.
 *
 * The sheet is .xlsx; export the "Case Follow ups" tab to CSV first
 * (File → Save As → CSV, or `in2csv`), then point --csv at it.
 *
 * Usage:
 *   npx tsx scripts/sync-closing-book.ts --org <uuid> --csv <path>          # dry-run (default)
 *   npx tsx scripts/sync-closing-book.ts --org <uuid> --csv <path> --apply  # write
 *
 * Env (from .env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import Papa from 'papaparse'
import {
  planClosingBookSync,
  type SheetCase,
  type ExistingRow,
} from '../src/lib/pipeline/closing-book-sync'
import { resolveClosingLead } from '../src/lib/pipeline/closing-book-leads'

// "Case Follow ups" column positions (0-indexed). Col F (5) is the unlabeled
// short gut-feel flag; G (6) is the status narrative.
const COL = { first: 0, last: 1, service: 2, lastContact: 3, cost: 4, gutFeel: 5, narrative: 6, strategy: 7, notes: 8 }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function parseCost(raw: string | undefined): number | null {
  if (!raw) return null
  const n = Number(raw.replace(/[$,\s]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

function cell(row: string[], i: number): string | null {
  const v = row[i]
  return v != null && String(v).trim() !== '' ? String(v).trim() : null
}

function parseSheet(csv: string): SheetCase[] {
  const { data } = Papa.parse<string[]>(csv, { skipEmptyLines: true })
  const cases: SheetCase[] = []
  for (const row of data) {
    let first = cell(row, COL.first)
    let last = cell(row, COL.last)
    if (!first && !last) continue
    if ((first ?? '').toLowerCase() === 'name') continue // header
    // Some rows put the whole name in the first cell with a blank last-name
    // (e.g. "Russel Bradford"). Split on the last space so it matches the split
    // stored in the table; single names ("Gerri") have no space and are kept.
    if (first && !last && first.includes(' ')) {
      const at = first.lastIndexOf(' ')
      last = first.slice(at + 1)
      first = first.slice(0, at)
    }
    cases.push({
      firstName: first ?? '',
      lastName: last ?? '',
      service: cell(row, COL.service),
      cost: parseCost(row[COL.cost]),
      lastContactRaw: cell(row, COL.lastContact),
      gutFeel: cell(row, COL.gutFeel),
      narrative: cell(row, COL.narrative),
      strategy: cell(row, COL.strategy),
      notes: cell(row, COL.notes),
    })
  }
  return cases
}

async function main() {
  const org = arg('org')
  const csvPath = arg('csv')
  const apply = process.argv.includes('--apply')
  if (!org || !csvPath) {
    console.error('Usage: tsx scripts/sync-closing-book.ts --org <uuid> --csv <path> [--apply]')
    process.exit(1)
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env')
    process.exit(1)
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } })

  const cases = parseSheet(readFileSync(csvPath, 'utf8'))
  console.log(`Parsed ${cases.length} cases from ${csvPath}`)

  const { data: existing, error } = await supabase
    .from('closing_book')
    .select('id, first_name, last_name, service, case_value, status_raw, won, last_contact_at, source')
    .eq('organization_id', org)
  if (error) throw error

  const plan = planClosingBookSync(cases, (existing ?? []) as ExistingRow[])
  console.log(
    `\nPlan: ${plan.inserts.length} insert · ${plan.updates.length} update · ` +
      `${plan.deletes.length} delete · ${plan.unchanged} unchanged`
  )
  for (const i of plan.inserts) console.log(`  + ${i.first_name} ${i.last_name}  $${i.case_value ?? '—'}`)
  for (const u of plan.updates) console.log(`  ~ ${u.first_name} ${u.last_name}  ${JSON.stringify(u.changes)}`)
  for (const d of plan.deletes) console.log(`  - ${d.first_name} ${d.last_name}`)

  if (!apply) {
    console.log('\nDry-run (no writes). Re-run with --apply to persist.')
    return
  }

  // Give every new patient a reachable CRM record: link the one match, mint a
  // bare record when none exists (sheet-only deals), leave ambiguous names for a
  // human to resolve on the board. Keeps each closing row clickable into Call /
  // SMS / Email + the lead detail.
  for (const ins of plan.inserts) {
    const resolution = await resolveClosingLead(supabase, org, {
      firstName: ins.first_name,
      lastName: ins.last_name,
      service: ins.service,
      caseValue: ins.case_value,
    })
    const lead_id = resolution.status === 'linked' ? resolution.leadId : null
    const { error: insErr } = await supabase.from('closing_book').insert({ ...ins, organization_id: org, lead_id })
    if (insErr) throw insErr
    const how =
      resolution.status === 'linked'
        ? resolution.created ? 'created lead' : 'linked lead'
        : resolution.status === 'ambiguous'
          ? `ambiguous (${resolution.candidateCount} matches — link on board)`
          : 'unlinked'
    console.log(`    ↳ ${ins.first_name} ${ins.last_name}: ${how}`)
  }
  for (const u of plan.updates) {
    const { error: upErr } = await supabase
      .from('closing_book')
      .update({ ...u.changes, updated_at: new Date().toISOString() })
      .eq('id', u.id)
    if (upErr) throw upErr
  }
  if (plan.deletes.length) {
    const { error: delErr } = await supabase
      .from('closing_book')
      .delete()
      .in('id', plan.deletes.map((d) => d.id))
    if (delErr) throw delErr
  }
  console.log('\nApplied.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
