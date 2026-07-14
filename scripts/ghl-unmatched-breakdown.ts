/**
 * DIAGNOSTIC (READ-ONLY — writes nothing): break down the GHL opportunities that
 * do NOT match an LI lead, to decide whether the mismatch is an ingestion gap
 * (contact absent from LI) or a fixable hashing/format bug (contact present in LI
 * but stored under a phone hash that doesn't equal searchHash(formatToE164(phone))).
 *
 * For each unmatched, mapped opp we:
 *   - record its projected LI stage (so we can see how many are Won/Booked/etc.)
 *   - probe LI with several phone-hash VARIANTS. If a variant hits a stored
 *     LI phone_hash, the lead is really in LI and only a re-normalize is needed
 *     → "recoverable". Otherwise → "absent".
 *
 * Usage: npx tsx scripts/ghl-unmatched-breakdown.ts
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getGhlConfig, fetchPipelines, ghlFetch } from '../src/lib/ghl/client'
import type { GhlConfig, GhlOpportunity } from '../src/lib/ghl/types'
import { searchHash } from '../src/lib/encryption'
import { formatToE164 } from '../src/lib/leads/phone'
import { resolveReconcileTarget } from '../src/lib/ghl/reconcile-map'

const ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c' // SF Dentistry
const PAGE_LIMIT = 100

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

/** Phone-hash variants: how the SAME number might have been stored at LI ingest. */
function phoneHashVariants(raw: string | null): string[] {
  if (!raw) return []
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 10) return []
  const last10 = digits.slice(-10)
  const candidates = new Set<string>([
    formatToE164(raw) ?? '',   // +1XXXXXXXXXX (canonical — already tried, but harmless)
    raw.trim(),                // exactly as GHL sent it
    digits,                    // 1XXXXXXXXXX or XXXXXXXXXX, no plus
    last10,                    // bare 10-digit
    `+${digits}`,              // +1XXXXXXXXXX or +XXXXXXXXXX
    `1${last10}`,              // 1 + 10
    `+1${last10}`,             // +1 + 10
    `(${last10.slice(0,3)}) ${last10.slice(3,6)}-${last10.slice(6)}`, // (XXX) XXX-XXXX
    `${last10.slice(0,3)}-${last10.slice(3,6)}-${last10.slice(6)}`,   // XXX-XXX-XXXX
  ])
  candidates.delete('')
  return [...candidates].map((c) => searchHash(c)).filter((h): h is string => !!h)
}

async function main() {
  const supabase: SupabaseClient = createClient(
    req('NEXT_PUBLIC_SUPABASE_URL'), req('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  )
  const config = await getGhlConfig(supabase, ORG_ID)
  if (!config) { console.error('getGhlConfig null'); process.exit(1) }

  // ---- Load ALL LI lead hashes once ----
  const emailHashes = new Set<string>()
  const phoneHashes = new Set<string>()
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('leads').select('email_hash, phone_hash')
      .eq('organization_id', ORG_ID).order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) { console.error(error.message); process.exit(1) }
    const rows = (data ?? []) as Array<{ email_hash: string | null; phone_hash: string | null }>
    for (const r of rows) {
      if (r.email_hash) emailHashes.add(r.email_hash)
      if (r.phone_hash) phoneHashes.add(r.phone_hash)
    }
    if (rows.length < PAGE) break
  }
  process.stderr.write(`  LI hashes: ${emailHashes.size} email, ${phoneHashes.size} phone\n`)

  // ---- Sweep GHL, classify each unmatched mapped opp ----
  const pipelines = await fetchPipelines(config)
  const byStage: Record<string, { total: number; recoverable: number; absent: number; emailOnly: number; phoneOnly: number; both: number; noContact: number }> = {}
  const bucket = (s: string) => (byStage[s] ??= { total: 0, recoverable: 0, absent: 0, emailOnly: 0, phoneOnly: 0, both: 0, noContact: 0 })

  let unmatchedTotal = 0
  for (const pipeline of pipelines) {
    const stageName = new Map<string, string>()
    for (const st of pipeline.stages ?? []) stageName.set(st.id, st.name)
    for await (const opp of iterateOpportunities(config, pipeline.id)) {
      const sName = opp.pipelineStageId ? stageName.get(opp.pipelineStageId) : undefined
      const target = resolveReconcileTarget(sName, opp.status)
      if (!target) continue // unmapped — not our concern here
      const email = opp.contact?.email?.trim() || null
      const phone = opp.contact?.phone?.trim() || null
      const emailHash = email ? searchHash(email) : null
      const phoneHashCanon = phone ? searchHash(formatToE164(phone)) : null
      const canonMatch = (emailHash && emailHashes.has(emailHash)) || (phoneHashCanon && phoneHashes.has(phoneHashCanon))
      if (canonMatch) continue // already matched by the real reconcile — skip

      // This opp is UNMATCHED. Classify it.
      unmatchedTotal += 1
      const b = bucket(target.stageSlug)
      b.total += 1
      if (!emailHash && !phoneHashCanon) { b.noContact += 1; continue }
      if (emailHash && phoneHashCanon) b.both += 1
      else if (emailHash) b.emailOnly += 1
      else b.phoneOnly += 1

      const emailRecoverable = false // canonical email already tried; email has no format variance
      const phoneRecoverable = phoneHashVariants(phone).some((h) => phoneHashes.has(h))
      if (emailRecoverable || phoneRecoverable) b.recoverable += 1
      else b.absent += 1
    }
    process.stderr.write(`  swept "${pipeline.name}"\n`)
  }

  // ---- Report ----
  const order = ['completed','contract-signed','scheduled','financing','treatment-presented',
    'consultation-completed','consultation-scheduled','qualified','contacted','no-communication','dnd-sms','lost','new']
  const stages = Object.keys(byStage).sort((a, b) => (order.indexOf(a) - order.indexOf(b)))
  const pad = (s: string | number, n: number) => String(s).padStart(n)
  console.log(`\n================ UNMATCHED GHL OPPS — BREAKDOWN (${unmatchedTotal}) ================`)
  console.log(`${'stage'.padEnd(24)}${pad('total',7)}${pad('recover',9)}${pad('absent',8)}${pad('email',7)}${pad('phone',7)}${pad('both',6)}${pad('noContact',10)}`)
  const T = { total:0, recoverable:0, absent:0, emailOnly:0, phoneOnly:0, both:0, noContact:0 }
  for (const s of stages) {
    const b = byStage[s]
    for (const k of Object.keys(T) as (keyof typeof T)[]) T[k] += b[k]
    console.log(`${s.padEnd(24)}${pad(b.total,7)}${pad(b.recoverable,9)}${pad(b.absent,8)}${pad(b.emailOnly,7)}${pad(b.phoneOnly,7)}${pad(b.both,6)}${pad(b.noContact,10)}`)
  }
  console.log('-'.repeat(78))
  console.log(`${'TOTAL'.padEnd(24)}${pad(T.total,7)}${pad(T.recoverable,9)}${pad(T.absent,8)}${pad(T.emailOnly,7)}${pad(T.phoneOnly,7)}${pad(T.both,6)}${pad(T.noContact,10)}`)
  console.log('\nrecover = a phone-hash variant hit an existing LI lead (present in LI, only a re-normalize needed)')
  console.log('absent  = no LI lead found under any variant (genuine ingestion gap)')
}

main().catch((e) => { console.error(e); process.exit(1) })
