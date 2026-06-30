/**
 * One-time importer: GHL Full-Arch "cold" opportunities → Lead Intelligence.
 *
 * Pulls opportunities from the GHL Full-Arch pipeline that sit in the cold
 * stages (Low-interest / No-Communication / Not-Interested), maps them to LI
 * leads tagged `full-arch-cold` with consent left UNKNOWN (nothing is granted —
 * consent is earned later via the /optin re-permission flow), and inserts them
 * into the LI leads table with PII encrypted to match the app.
 *
 * SAFE BY DEFAULT: dry-run unless DRY_RUN=false. Idempotent: dedupes against
 * existing LI leads by deterministic email/phone hash, so re-runs don't double.
 *
 * Usage:
 *   GHL_API_TOKEN=... GHL_LOCATION_ID=... LI_ORG_ID=... \
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... ENCRYPTION_KEY=... \
 *   npx tsx scripts/import-ghl-full-arch-cold.ts            # dry run
 *   ... DRY_RUN=false npx tsx scripts/import-ghl-full-arch-cold.ts   # actually insert
 *
 * Optional env:
 *   GHL_PIPELINE_ID   (default K4oJK1AhnVAaTWrQyHPZ — the Full-Arch pipeline)
 *   GHL_COLD_STAGES   (comma list of stage-name substrings; default
 *                      "Low-interest,No-Communication,Not-Interested")
 *   IMPORT_TAG        (default "full-arch-cold")
 *   IMPORT_LIMIT      (cap the number imported; default unlimited)
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { encryptLeadPII, searchHash } from '../src/lib/encryption'

const GHL_BASE = 'https://services.leadconnectorhq.com'
const GHL_VERSION = '2021-07-28'

function reqEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`❌ Missing required env: ${name}`)
    process.exit(1)
  }
  return v
}

const GHL_TOKEN = reqEnv('GHL_API_TOKEN')
const LOCATION_ID = reqEnv('GHL_LOCATION_ID')
const ORG_ID = reqEnv('LI_ORG_ID')
const PIPELINE_ID = process.env.GHL_PIPELINE_ID || 'K4oJK1AhnVAaTWrQyHPZ'
const COLD_STAGE_NEEDLES = (process.env.GHL_COLD_STAGES || 'Low-interest,No-Communication,Not-Interested')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)
const IMPORT_TAG = process.env.IMPORT_TAG || 'full-arch-cold'
const IMPORT_LIMIT = process.env.IMPORT_LIMIT ? Number(process.env.IMPORT_LIMIT) : Infinity
const DRY_RUN = process.env.DRY_RUN !== 'false'

const supabase = createClient(reqEnv('NEXT_PUBLIC_SUPABASE_URL'), reqEnv('SUPABASE_SERVICE_ROLE_KEY'))

function ghlHeaders() {
  return { Authorization: `Bearer ${GHL_TOKEN}`, Version: GHL_VERSION, Accept: 'application/json' }
}

/** Minimal E.164 normalize (US default). Returns null if it can't be made E.164-ish. */
function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (trimmed.startsWith('+')) return '+' + trimmed.slice(1).replace(/\D/g, '')
  const digits = trimmed.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return digits ? `+${digits}` : null
}

type GhlStage = { id: string; name: string }
type GhlContact = {
  id?: string
  name?: string
  contactName?: string
  firstName?: string
  lastName?: string
  email?: string
  phone?: string
}
type GhlOpp = {
  id: string
  pipelineStageId?: string
  contactId?: string
  contact?: GhlContact
}

async function fetchColdStageIds(): Promise<Set<string>> {
  const res = await fetch(`${GHL_BASE}/opportunities/pipelines?locationId=${LOCATION_ID}`, {
    headers: ghlHeaders(),
  })
  if (!res.ok) {
    console.error(`❌ GHL pipelines fetch failed: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  const data = (await res.json()) as { pipelines?: Array<{ id: string; name: string; stages?: GhlStage[] }> }
  const pipeline = (data.pipelines || []).find((p) => p.id === PIPELINE_ID)
  if (!pipeline) {
    console.error(`❌ Pipeline ${PIPELINE_ID} not found in location ${LOCATION_ID}`)
    process.exit(1)
  }
  const cold = new Set<string>()
  console.log(`\nPipeline "${pipeline.name}" stages:`)
  for (const st of pipeline.stages || []) {
    const isCold = COLD_STAGE_NEEDLES.some((needle) => st.name.toLowerCase().includes(needle))
    console.log(`  ${isCold ? '🧊' : '  '} ${st.name} (${st.id})`)
    if (isCold) cold.add(st.id)
  }
  if (cold.size === 0) {
    console.error(`❌ No stages matched cold needles [${COLD_STAGE_NEEDLES.join(', ')}]. Adjust GHL_COLD_STAGES.`)
    process.exit(1)
  }
  return cold
}

async function fetchColdOpps(coldStageIds: Set<string>): Promise<GhlOpp[]> {
  const kept: GhlOpp[] = []
  let page = 1
  const PER = 100
  for (; page <= 200; page++) {
    const url = `${GHL_BASE}/opportunities/search?location_id=${LOCATION_ID}&pipeline_id=${PIPELINE_ID}&limit=${PER}&page=${page}`
    const res = await fetch(url, { headers: ghlHeaders() })
    if (!res.ok) {
      console.error(`❌ GHL opportunities fetch failed (page ${page}): ${res.status} ${await res.text()}`)
      process.exit(1)
    }
    const data = (await res.json()) as { opportunities?: GhlOpp[] }
    const opps = data.opportunities || []
    for (const o of opps) {
      if (o.pipelineStageId && coldStageIds.has(o.pipelineStageId)) kept.push(o)
    }
    process.stdout.write(`\r  fetched page ${page} (${opps.length} opps, ${kept.length} cold so far)…`)
    if (opps.length < PER) break
  }
  console.log('')
  return kept
}

async function resolveContact(o: GhlOpp): Promise<GhlContact | null> {
  if (o.contact && (o.contact.email || o.contact.phone)) return o.contact
  const contactId = o.contactId || o.contact?.id
  if (!contactId) return o.contact ?? null
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}`, { headers: ghlHeaders() })
  if (!res.ok) return o.contact ?? null
  const data = (await res.json()) as { contact?: GhlContact }
  return data.contact ?? o.contact ?? null
}

function splitName(c: GhlContact): { first: string; last: string | null } {
  if (c.firstName || c.lastName) return { first: c.firstName || c.lastName || 'Unknown', last: c.lastName || null }
  const full = (c.name || c.contactName || '').trim()
  if (!full) return { first: 'Unknown', last: null }
  const [first, ...rest] = full.split(/\s+/)
  return { first, last: rest.length ? rest.join(' ') : null }
}

async function main() {
  console.log(`\n🧊 GHL → LI cold full-arch importer  ${DRY_RUN ? '(DRY RUN)' : '(LIVE INSERT)'}`)
  console.log(`   org=${ORG_ID}  pipeline=${PIPELINE_ID}  tag=${IMPORT_TAG}`)

  const coldStageIds = await fetchColdStageIds()
  const opps = await fetchColdOpps(coldStageIds)
  console.log(`\nFound ${opps.length} cold opportunities. Resolving contacts…`)

  // Build candidate lead rows (plaintext), de-duped within the batch by hash.
  type Candidate = { insert: Record<string, unknown>; emailHash: string | null; phoneHash: string | null }
  const candidates: Candidate[] = []
  const seen = new Set<string>()
  let noContact = 0

  for (const o of opps) {
    if (candidates.length >= IMPORT_LIMIT) break
    const contact = await resolveContact(o)
    const email = contact?.email?.trim() || null
    const phoneRaw = contact?.phone?.trim() || null
    const phoneFormatted = toE164(phoneRaw)
    if (!email && !phoneFormatted) {
      noContact++
      continue
    }
    const emailHash = email ? searchHash(email) : null
    const phoneHash = phoneFormatted ? searchHash(phoneFormatted) : null
    const dedupeKey = `${emailHash ?? ''}|${phoneHash ?? ''}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    const { first, last } = splitName(contact || {})
    candidates.push({
      emailHash,
      phoneHash,
      insert: {
        organization_id: ORG_ID,
        first_name: first,
        last_name: last,
        email,
        phone: phoneRaw,
        phone_formatted: phoneFormatted,
        status: 'contacted',
        source_type: 'ghl_full_arch_cold',
        source_id: o.id,
        tags: [IMPORT_TAG],
        // Consent: NOTHING granted. Earned later via /optin re-permission.
        sms_consent: false,
        email_consent: false,
        voice_consent: false,
        do_not_call: false,
      },
    })
  }

  // Dedupe against existing LI leads by hash (idempotent re-runs).
  const emailHashes = candidates.map((c) => c.emailHash).filter(Boolean) as string[]
  const phoneHashes = candidates.map((c) => c.phoneHash).filter(Boolean) as string[]
  const existing = new Set<string>()
  for (const [col, vals] of [['email_hash', emailHashes], ['phone_hash', phoneHashes]] as const) {
    for (let i = 0; i < vals.length; i += 200) {
      const chunk = vals.slice(i, i + 200)
      if (!chunk.length) continue
      const { data } = await supabase.from('leads').select(col).eq('organization_id', ORG_ID).in(col, chunk)
      for (const row of data || []) {
        const v = (row as Record<string, string | null>)[col]
        if (v) existing.add(v)
      }
    }
  }
  const fresh = candidates.filter(
    (c) => !(c.emailHash && existing.has(c.emailHash)) && !(c.phoneHash && existing.has(c.phoneHash)),
  )

  console.log(`\nSummary:`)
  console.log(`  cold opportunities:        ${opps.length}`)
  console.log(`  skipped (no email/phone):  ${noContact}`)
  console.log(`  unique candidates:         ${candidates.length}`)
  console.log(`  already in LI (deduped):   ${candidates.length - fresh.length}`)
  console.log(`  → to import:               ${fresh.length}`)

  if (DRY_RUN) {
    console.log(`\n📋 DRY RUN — no rows inserted. Sample of up to 5:`)
    for (const c of fresh.slice(0, 5)) {
      console.log(`   • ${c.insert.first_name} ${c.insert.last_name ?? ''}  email=${c.insert.email ? 'yes' : 'no'} phone=${c.insert.phone_formatted ?? 'no'}`)
    }
    console.log(`\nRe-run with DRY_RUN=false to insert.`)
    return
  }

  let inserted = 0
  for (let i = 0; i < fresh.length; i += 100) {
    const chunk = fresh.slice(i, i + 100).map((c) => encryptLeadPII(c.insert))
    const { data, error } = await supabase.from('leads').insert(chunk).select('id')
    if (error) {
      console.error(`❌ Insert chunk @${i} failed: ${error.message}`)
      continue
    }
    inserted += data?.length || 0
    process.stdout.write(`\r  inserted ${inserted}/${fresh.length}…`)
  }
  console.log(`\n✅ Imported ${inserted} cold full-arch leads into LI, tagged "${IMPORT_TAG}", consent unknown.`)
  console.log(`   Next: flip org consent_capture flag + run the re-permission cron to earn consent.`)
}

main().catch((err) => {
  console.error('\n❌ Importer failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
