/**
 * Backfill CRM leads for closing-book rows the seed left unlinked.
 *
 * The In-Closing board (`closing_book`) is only clickable into Call / SMS /
 * Email + the lead detail when a row's `lead_id` is set. The original seed only
 * linked rows whose sheet name matched exactly one lead, so pre-CRM / referral
 * deals (no lead) and duplicate-name deals were left unlinked. This one-time,
 * idempotent pass resolves them:
 *
 *   - exactly one lead with the name → link it
 *   - no lead with the name          → create a bare record and link it
 *   - several leads with the name    → skip (a human links it on the board)
 *
 * Safe to re-run: it only touches rows where `lead_id` is null.
 *
 * Usage:
 *   npx tsx scripts/backfill-closing-leads.ts --org <uuid>          # dry-run (default)
 *   npx tsx scripts/backfill-closing-leads.ts --org <uuid> --apply  # write
 *
 * Env (from .env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import { createClient } from '@supabase/supabase-js'
import { resolveClosingLead } from '../src/lib/pipeline/closing-book-leads'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

type UnlinkedRow = {
  id: string
  first_name: string
  last_name: string
  service: string | null
  case_value: number | null
}

async function main() {
  const org = arg('org')
  const apply = process.argv.includes('--apply')
  if (!org) {
    console.error('Usage: tsx scripts/backfill-closing-leads.ts --org <uuid> [--apply]')
    process.exit(1)
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env')
    process.exit(1)
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } })

  const { data, error } = await supabase
    .from('closing_book')
    .select('id, first_name, last_name, service, case_value')
    .eq('organization_id', org)
    .is('lead_id', null)
    .order('sort_order', { ascending: true })
  if (error) throw error

  const rows = (data ?? []) as UnlinkedRow[]
  console.log(`Found ${rows.length} unlinked closing rows for org ${org}\n`)

  let linked = 0
  let willCreate = 0
  let created = 0
  let ambiguous = 0

  for (const row of rows) {
    const name = `${row.first_name} ${row.last_name}`.trim()
    // create only under --apply, so a dry-run never mints orphan leads.
    const resolution = await resolveClosingLead(
      supabase,
      org,
      { firstName: row.first_name, lastName: row.last_name, service: row.service, caseValue: row.case_value },
      { create: apply }
    )

    if (resolution.status === 'ambiguous') {
      ambiguous++
      console.log(`  ? ${name}: ${resolution.candidateCount} matching patients — skip (link on board)`)
      continue
    }

    if (resolution.status === 'none') {
      // Dry-run: a real run would create + link a bare record here.
      willCreate++
      console.log(`  + ${name}: would create a new patient record`)
      continue
    }

    if (resolution.created) created++
    else linked++

    const { error: upErr } = await supabase
      .from('closing_book')
      .update({ lead_id: resolution.leadId, updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('organization_id', org)
    if (upErr) throw upErr
    console.log(`  ${resolution.created ? '+' : '~'} ${name}: ${resolution.created ? 'created' : 'linked'} ${resolution.leadId}`)
  }

  if (apply) {
    console.log(`\nApplied: ${linked} linked · ${created} created · ${ambiguous} ambiguous (left for board)`)
  } else {
    console.log(`\nDry-run: ${linked} would link · ${willCreate} would create · ${ambiguous} ambiguous (left for board)`)
    console.log('Re-run with --apply to persist.')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
