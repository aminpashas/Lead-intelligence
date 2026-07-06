/**
 * DIAGNOSTIC (READ-ONLY): GHL CONTACTS (master people list, location-wide) vs LI.
 *
 * Unlike the opportunity audits, this sweeps GHL's /contacts/search — every
 * contact in the location, including people who never entered a pipeline — and
 * checks each against the LI lead book by email/phone hash. Answers: how many
 * contacts does GHL have, and how many do we now hold in LI (post-import)?
 *
 * Usage: npx tsx scripts/ghl-contact-coverage-audit.ts
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getGhlConfig } from '../src/lib/ghl/client'
import { searchHash } from '../src/lib/encryption'
import { formatToE164 } from '../src/lib/leads/phone'

const ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c' // SF Dentistry
const GHL_BASE = 'https://services.leadconnectorhq.com'
const PAGE_LIMIT = 100

function req(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`Missing env: ${name}`); process.exit(1) }
  return v
}

type GhlContact = {
  id?: string
  email?: string | null
  phone?: string | null
  dnd?: boolean
}

async function main() {
  const supabase: SupabaseClient = createClient(
    req('NEXT_PUBLIC_SUPABASE_URL'), req('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  )
  const config = await getGhlConfig(supabase, ORG_ID)
  if (!config) { console.error('getGhlConfig null'); process.exit(1) }

  // Load all LI lead hashes for the org.
  const emailHashes = new Set<string>()
  const phoneHashes = new Set<string>()
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('leads').select('email_hash, phone_hash')
      .eq('organization_id', ORG_ID).order('id', { ascending: true }).range(from, from + PAGE - 1)
    if (error) { console.error(error.message); process.exit(1) }
    const rows = (data ?? []) as Array<{ email_hash: string | null; phone_hash: string | null }>
    for (const r of rows) { if (r.email_hash) emailHashes.add(r.email_hash); if (r.phone_hash) phoneHashes.add(r.phone_hash) }
    if (rows.length < PAGE) break
  }
  process.stderr.write(`  LI hashes: ${emailHashes.size} email, ${phoneHashes.size} phone\n`)

  const headers = {
    Authorization: `Bearer ${config.apiToken}`,
    Version: config.version,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }

  // Sweep ALL contacts via /contacts/search with a wide date-added range so
  // nothing is windowed out. Cursor via sortValues (searchAfter).
  let total = 0, withContact = 0, noContact = 0
  let matched = 0, missing = 0, dndMissing = 0
  let reportedTotal: number | null = null
  let searchAfter: unknown[] | undefined
  for (let page = 0; page < 100000; page++) {
    const body: Record<string, unknown> = {
      locationId: config.locationId,
      pageLimit: PAGE_LIMIT,
      filters: [{ field: 'dateAdded', operator: 'range', value: { gte: '2000-01-01T00:00:00.000Z', lte: '2035-01-01T00:00:00.000Z' } }],
      sort: [{ field: 'dateAdded', direction: 'desc' }],
    }
    if (searchAfter) body.searchAfter = searchAfter
    const res = await fetch(`${GHL_BASE}/contacts/search`, { method: 'POST', headers, body: JSON.stringify(body) })
    if (!res.ok) { console.error(`GHL ${res.status}: ${(await res.text()).slice(0, 300)}`); process.exit(1) }
    const payload = await res.json() as { contacts?: GhlContact[]; total?: number; meta?: { total?: number } }
    if (reportedTotal == null) reportedTotal = payload.total ?? payload.meta?.total ?? null
    const contacts = payload.contacts ?? []
    for (const c of contacts) {
      total += 1
      const email = c.email?.trim() || null
      const phone = c.phone?.trim() || null
      const eHash = email ? searchHash(email) : null
      const pHash = phone ? searchHash(formatToE164(phone)) : null
      if (!eHash && !pHash) { noContact += 1; continue }
      withContact += 1
      const inLi = (eHash && emailHashes.has(eHash)) || (pHash && phoneHashes.has(pHash))
      if (inLi) matched += 1
      else { missing += 1; if (c.dnd) dndMissing += 1 }
    }
    const last = contacts[contacts.length - 1] as (GhlContact & { searchAfter?: unknown[] }) | undefined
    searchAfter = last?.searchAfter
    if (contacts.length < PAGE_LIMIT || !searchAfter) break
    if (total % 5000 === 0) process.stderr.write(`  swept contacts: ${total}\n`)
  }

  const pct = (n: number) => withContact ? `${((n / withContact) * 100).toFixed(1)}%` : 'n/a'
  console.log(`\n============ GHL CONTACTS vs LI — COVERAGE AUDIT ============`)
  console.log(`GHL reported total (meta):   ${reportedTotal ?? 'n/a'}`)
  console.log(`GHL contacts swept:          ${total}`)
  console.log(`  with email/phone:          ${withContact}`)
  console.log(`  no contact info:           ${noContact}`)
  console.log(`\nOf contactable GHL people:`)
  console.log(`  IN LI (matched):           ${matched}  (${pct(matched)})`)
  console.log(`  MISSING from LI:           ${missing}  (${pct(missing)})`)
  console.log(`    of which GHL-DND:        ${dndMissing}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
