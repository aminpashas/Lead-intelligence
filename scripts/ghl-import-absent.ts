/**
 * One-time import of GHL opportunities that have NO matching LI lead
 * ("everything, suppression-first" — SF Dentistry).
 *
 * WHY: reconcile.ts is reconcile-ONLY (never creates leads); the DGS bridge
 * doesn't carry these ~14k contacts, so they're invisible in LI. This CREATES
 * one LI lead per absent GHL person, stamped with their GHL-mapped stage.
 *
 * SAFETY / COMPLIANCE (suppression-first):
 *   - Reuses ingestLead → dedup by email/phone hash, PII encrypted, `created`
 *     activity + HIPAA audit written, speed-to-lead OFF (cold bulk).
 *   - Consent left UNKNOWN for every lead (never fabricated). The send gate only
 *     allows on boolean-true, so unknown = NOT blastable until re-permission.
 *   - GHL DND cohorts get explicit suppression post-insert: DND SMS →
 *     sms declined+opt_out; "Do Not Disturb" → all channels declined+opt_out.
 *   - Opportunities are folded to ONE lead per person at their MOST-ADVANCED
 *     stage (won > funnel > contacted > lost > new); DND flags OR across opps.
 *   - Only opps with NO canonical LI match are imported (already-present skipped).
 *
 * DRY-RUN by default. Pass --apply to write.
 *   npx tsx scripts/ghl-import-absent.ts
 *   npx tsx scripts/ghl-import-absent.ts --apply
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getGhlConfig, fetchPipelines, ghlFetch } from '../src/lib/ghl/client'
import type { GhlConfig, GhlOpportunity } from '../src/lib/ghl/types'
import { searchHash } from '../src/lib/encryption'
import { formatToE164 } from '../src/lib/leads/phone'
import { ingestLead } from '../src/lib/leads/ingest'
import { resolveReconcileTarget, type LiStageSlug, type ReconcileTarget } from '../src/lib/ghl/reconcile-map'

const ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c' // SF Dentistry
const APPLY = process.argv.includes('--apply')
const PAGE_LIMIT = 100
const CONCURRENCY = 10

/** Most-advanced-wins when a person has several opportunities. */
const PRIORITY: Record<LiStageSlug, number> = {
  completed: 14, 'contract-signed': 13, scheduled: 12, financing: 11,
  'treatment-presented': 10, 'consultation-completed': 9, 'consultation-scheduled': 8,
  qualified: 7, engaged: 6, contacted: 5, 'no-communication': 4, 'dnd-sms': 3, lost: 2, new: 1,
}

function req(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`Missing env: ${name}`); process.exit(1) }
  return v
}

async function* iterateOpportunities(config: GhlConfig, pipelineId: string): AsyncGenerator<GhlOpportunity> {
  let startAfter: string | undefined
  let startAfterId: string | undefined
  for (let guard = 0; guard < 5000; guard++) {
    const data = await ghlFetch<{ opportunities?: GhlOpportunity[]; meta?: Record<string, unknown> }>(
      config, '/opportunities/search',
      { location_id: config.locationId, pipeline_id: pipelineId, limit: PAGE_LIMIT, startAfter, startAfterId },
    )
    const opps = data.opportunities ?? []
    for (const o of opps) yield o
    if (opps.length < PAGE_LIMIT) return
    const meta = data.meta ?? {}
    startAfter = meta.startAfter != null ? String(meta.startAfter) : undefined
    startAfterId = meta.startAfterId != null ? String(meta.startAfterId) : undefined
    if (!startAfter || !startAfterId) return
  }
}

/** Best-effort split of a GHL contact/opp into first + last name. */
function names(opp: GhlOpportunity): { first: string; last: string | null } {
  const c = opp.contact ?? {}
  if (c.firstName?.trim()) return { first: c.firstName.trim(), last: c.lastName?.trim() || null }
  const full = (c.name || c.contactName || opp.name || '').trim()
  if (full) {
    const parts = full.split(/\s+/)
    return { first: parts[0], last: parts.slice(1).join(' ') || null }
  }
  return { first: 'Unknown', last: null }
}

type Person = {
  key: string
  first: string
  last: string | null
  email: string | null
  phoneRaw: string | null
  target: ReconcileTarget
  smsDnd: boolean
  allChannelDnd: boolean
  oppId: string
}

async function main() {
  const supabase: SupabaseClient = createClient(
    req('NEXT_PUBLIC_SUPABASE_URL'), req('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  )
  const config = await getGhlConfig(supabase, ORG_ID)
  if (!config) { console.error('getGhlConfig null'); process.exit(1) }

  // Stage slug -> id. no-communication / dnd-sms already exist (reconcile created them).
  const { data: stageRows } = await supabase
    .from('pipeline_stages').select('id, slug').eq('organization_id', ORG_ID)
  const slugToId = new Map<string, string>()
  for (const r of (stageRows ?? []) as Array<{ id: string; slug: string }>) slugToId.set(r.slug, r.id)
  const needed = new Set<LiStageSlug>(Object.keys(PRIORITY) as LiStageSlug[])
  const missing = [...needed].filter((s) => !slugToId.has(s))
  if (missing.length) { console.error(`Missing LI stages (run reconcile first): ${missing.join(', ')}`); process.exit(1) }

  // Existing LI hashes → identify who is ALREADY present (skip those).
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
  process.stderr.write(`  LI existing: ${emailHashes.size} email, ${phoneHashes.size} phone hashes\n`)

  // Sweep GHL → fold absent opps into one Person per contact key.
  const pipelines = await fetchPipelines(config)
  const people = new Map<string, Person>()
  let scanned = 0, alreadyPresent = 0, noContact = 0, unmapped = 0
  for (const pipeline of pipelines) {
    const stageName = new Map<string, string>()
    for (const st of pipeline.stages ?? []) stageName.set(st.id, st.name)
    for await (const opp of iterateOpportunities(config, pipeline.id)) {
      scanned += 1
      const sName = opp.pipelineStageId ? stageName.get(opp.pipelineStageId) : undefined
      const target = resolveReconcileTarget(sName, opp.status)
      if (!target) { unmapped += 1; continue }
      const email = opp.contact?.email?.trim() || null
      const phoneRaw = opp.contact?.phone?.trim() || null
      const emailHash = email ? searchHash(email) : null
      const phoneFmt = phoneRaw ? formatToE164(phoneRaw) : null
      const phoneHash = phoneFmt ? searchHash(phoneFmt) : null
      if (!emailHash && !phoneHash) { noContact += 1; continue }
      if ((emailHash && emailHashes.has(emailHash)) || (phoneHash && phoneHashes.has(phoneHash))) { alreadyPresent += 1; continue }

      const key = emailHash ?? phoneHash!
      const { first, last } = names(opp)
      const existing = people.get(key)
      const smsDnd = Boolean(target.smsDnd) || Boolean(existing?.smsDnd)
      const allChannelDnd = Boolean(target.allChannelDnd) || Boolean(existing?.allChannelDnd)
      let chosen = existing?.target ?? target
      if (existing && PRIORITY[target.stageSlug] > PRIORITY[existing.target.stageSlug]) chosen = target
      people.set(key, {
        key,
        first: existing?.first || first,
        last: existing?.last ?? last,
        email: existing?.email ?? email,
        phoneRaw: existing?.phoneRaw ?? phoneRaw,
        target: chosen, smsDnd, allChannelDnd,
        oppId: existing?.oppId ?? opp.id,
      })
    }
    process.stderr.write(`  swept "${pipeline.name}" (people so far: ${people.size})\n`)
  }

  // Report the plan.
  const byStage = new Map<string, number>()
  let smsDndCount = 0, allDndCount = 0
  for (const p of people.values()) {
    byStage.set(p.target.stageSlug, (byStage.get(p.target.stageSlug) ?? 0) + 1)
    if (p.smsDnd) smsDndCount += 1
    if (p.allChannelDnd) allDndCount += 1
  }
  console.log(`\n============ GHL ABSENT-LEAD IMPORT ${APPLY ? '(APPLY)' : '(DRY RUN)'} ============`)
  console.log(`Opps scanned:            ${scanned}`)
  console.log(`  unmapped (skip):       ${unmapped}`)
  console.log(`  no contact (skip):     ${noContact}`)
  console.log(`  already in LI (skip):  ${alreadyPresent}`)
  console.log(`Distinct NEW people:     ${people.size}`)
  console.log(`  SMS-suppress (DND SMS):${smsDndCount}`)
  console.log(`  all-channel suppress:  ${allDndCount}`)
  console.log(`\n--- New leads by stage ---`)
  for (const [s, n] of [...byStage.entries()].sort((a, b) => PRIORITY[b[0] as LiStageSlug] - PRIORITY[a[0] as LiStageSlug]))
    console.log(`  ${String(n).padStart(6)}  ${s}`)

  if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply to import.'); return }

  // ---- Apply: ingestLead per person, then DND suppression post-update. ----
  console.log('\nImporting...')
  const list = [...people.values()]
  let inserted = 0, deduped = 0, suppressed = 0, errors = 0, cursor = 0
  async function worker() {
    while (cursor < list.length) {
      const p = list[cursor++]
      try {
        const res = await ingestLead(
          supabase,
          {
            organizationId: ORG_ID,
            firstName: p.first,
            lastName: p.last,
            email: p.email,
            phoneRaw: p.phoneRaw,
            sourceType: 'ghl_import',
            stageId: slugToId.get(p.target.stageSlug)!,
            externalRef: `ghl_opp:${p.oppId}`,
            // consent intentionally omitted → all channels UNKNOWN (not blastable)
          },
          { caller: 'ghl-import-absent', armSpeedToLead: false },
        )
        if (res.deduplicated) { deduped += 1 }
        else { inserted += 1 }
        // Suppression-first for GHL DND cohorts (applies even on a dedup hit).
        if (p.smsDnd || p.allChannelDnd) {
          const update: Record<string, unknown> = {
            sms_consent_status: 'declined', sms_opt_out: true, sms_consent_source: 'ghl_import',
          }
          if (p.allChannelDnd) {
            update.email_consent_status = 'declined'; update.email_opt_out = true; update.email_consent_source = 'ghl_import'
            update.voice_consent_status = 'declined'; update.voice_opt_out = true; update.voice_consent_source = 'ghl_import'
          }
          const { error } = await supabase.from('leads').update(update).eq('id', res.id)
          if (!error) suppressed += 1
        }
      } catch (e) {
        errors += 1
        if (errors <= 10) console.error(`  import ${p.key.slice(0, 8)} failed: ${(e as Error).message}`)
      }
      const done = inserted + deduped
      if (done && done % 1000 === 0) process.stderr.write(`  processed ${done}/${list.length} (inserted ${inserted})...\n`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  console.log(`\nDone. inserted=${inserted} deduped=${deduped} suppressed=${suppressed} errors=${errors}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
