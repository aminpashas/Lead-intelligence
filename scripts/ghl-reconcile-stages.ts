/**
 * One-time GHL -> LI stage reconciliation (SF Dentistry).
 *
 * Walks every active GHL pipeline, matches each opportunity to its LI lead by
 * email/phone hash, and reconciles the lead's pipeline stage to GHL's truth
 * using src/lib/ghl/reconcile-map. GHL is authoritative (per operator mandate):
 * a lead sitting in "New Lead" that is actually won/lost/booked in GHL is moved.
 *
 * Safety:
 *   - DRY-RUN by default. Prints the projected before/after board and every
 *     unmapped stage. Pass --apply to write.
 *   - Unrecognised GHL stages are SKIPPED, never reset to New Lead.
 *   - A person with several opportunities across pipelines is resolved to the
 *     single most-advanced stage (won > active funnel > contacted > lost > new).
 *   - DND flags accumulate across ALL of a lead's opportunities and set the
 *     consent columns the send-path gate honours (declined + opt_out).
 *
 * Usage:
 *   npx tsx scripts/ghl-reconcile-stages.ts            # dry run
 *   npx tsx scripts/ghl-reconcile-stages.ts --apply    # write
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getGhlConfig, fetchPipelines, ghlFetch } from '../src/lib/ghl/client'
import type { GhlConfig, GhlOpportunity } from '../src/lib/ghl/types'
import { searchHash } from '../src/lib/encryption'
import { formatToE164 } from '../src/lib/leads/phone'
import {
  resolveReconcileTarget,
  type LiStageSlug,
  type ReconcileTarget,
} from '../src/lib/ghl/reconcile-map'

const ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c' // SF Dentistry
const APPLY = process.argv.includes('--apply')
const PAGE_LIMIT = 100

/** Most-advanced-wins priority when a lead has multiple opportunities. */
const PRIORITY: Record<LiStageSlug, number> = {
  completed: 13,
  'contract-signed': 12,
  scheduled: 11,
  financing: 10,
  'treatment-presented': 9,
  'consultation-completed': 8,
  'consultation-scheduled': 7,
  qualified: 6,
  contacted: 5,
  'no-communication': 4,
  'dnd-sms': 3,
  lost: 2,
  new: 1,
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
      config,
      '/opportunities/search',
      {
        location_id: config.locationId,
        pipeline_id: pipelineId,
        limit: PAGE_LIMIT,
        startAfter: startAfter ?? undefined,
        startAfterId: startAfterId ?? undefined,
      },
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

/** What we decide to do to one LI lead after folding in all its opportunities. */
type LeadPlan = {
  leadId: string
  currentStageId: string | null
  target: ReconcileTarget
  smsDnd: boolean
  allChannelDnd: boolean
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function main() {
  const supabase: SupabaseClient = createClient(
    req('NEXT_PUBLIC_SUPABASE_URL'),
    req('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  )

  const config = await getGhlConfig(supabase, ORG_ID)
  if (!config) { console.error('getGhlConfig null'); process.exit(1) }

  // LI stage slug -> id.
  const loadStages = async () => {
    const { data } = await supabase
      .from('pipeline_stages')
      .select('id, slug, position')
      .eq('organization_id', ORG_ID)
    return (data ?? []) as Array<{ id: string; slug: string; position: number | null }>
  }
  let stageRows = await loadStages()
  const slugToId = new Map<string, string>()
  for (const r of stageRows) slugToId.set(r.slug, r.id)

  // The 11 native stages must already exist — never invent core pipeline stages.
  const NATIVE: LiStageSlug[] = [
    'new', 'contacted', 'qualified', 'consultation-scheduled', 'consultation-completed',
    'treatment-presented', 'financing', 'contract-signed', 'scheduled', 'completed', 'lost',
  ]
  const missingNative = NATIVE.filter((s) => !slugToId.has(s))
  if (missingNative.length) { console.error('Missing native LI stages:', missingNative.join(', ')); process.exit(1) }

  // Two operator-requested columns are find-or-created (No Communication, DND SMS).
  const PRESERVED: Array<{ slug: LiStageSlug; name: string }> = [
    { slug: 'no-communication', name: 'No Communication' },
    { slug: 'dnd-sms', name: 'DND SMS' },
  ]
  const toCreate = PRESERVED.filter((p) => !slugToId.has(p.slug))
  if (toCreate.length) {
    if (!APPLY) {
      console.log(`\n[dry run] would CREATE ${toCreate.length} column(s): ${toCreate.map((p) => p.name).join(', ')}`)
    } else {
      let pos = Math.max(0, ...stageRows.map((r) => r.position ?? 0)) + 1
      await supabase.from('pipeline_stages').insert(
        toCreate.map((p) => ({ organization_id: ORG_ID, name: p.name, slug: p.slug, position: pos++ })),
      )
      stageRows = await loadStages()
      slugToId.clear()
      for (const r of stageRows) slugToId.set(r.slug, r.id)
    }
  }
  const idToSlug = new Map<string, string>()
  for (const [slug, id] of slugToId) idToSlug.set(id, slug)

  const pipelines = await fetchPipelines(config)

  // ---- Phase A: read every opportunity, key by contact hash ----
  type OppRec = { emailHash: string | null; phoneHash: string | null; target: ReconcileTarget }
  const oppRecs: OppRec[] = []
  const unmapped = new Map<string, number>() // "pipeline :: stage" -> count
  let fetched = 0
  let noContact = 0

  for (const pipeline of pipelines) {
    const stageName = new Map<string, string>()
    for (const st of pipeline.stages ?? []) stageName.set(st.id, st.name)

    for await (const opp of iterateOpportunities(config, pipeline.id)) {
      fetched += 1
      const sName = opp.pipelineStageId ? stageName.get(opp.pipelineStageId) : undefined
      const target = resolveReconcileTarget(sName, opp.status)
      if (!target) {
        const key = `${pipeline.name} :: ${sName ?? '(no stage)'}`
        unmapped.set(key, (unmapped.get(key) ?? 0) + 1)
        continue
      }
      const email = opp.contact?.email?.trim() || null
      const phoneRaw = opp.contact?.phone?.trim() || null
      const emailHash = email ? searchHash(email) : null
      const phoneFormatted = phoneRaw ? formatToE164(phoneRaw) : null
      const phoneHash = phoneFormatted ? searchHash(phoneFormatted) : null
      if (!emailHash && !phoneHash) { noContact += 1; continue }
      oppRecs.push({ emailHash, phoneHash, target })
    }
    process.stderr.write(`  swept "${pipeline.name}" (running total opps: ${fetched})\n`)
  }

  // ---- Phase B: load ALL org leads once (paginated) and index by hash ----
  // Far fewer round-trips than per-hash .in() lookups, and O(1) matching after.
  type LeadRow = {
    id: string
    stage_id: string | null
    sms_consent_status: string | null
    email_consent_status: string | null
    email_hash: string | null
    phone_hash: string | null
  }
  const byEmail = new Map<string, LeadRow>()
  const byPhone = new Map<string, LeadRow>()
  const SELECT = 'id, stage_id, sms_consent_status, email_consent_status, email_hash, phone_hash'
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('leads')
      .select(SELECT)
      .eq('organization_id', ORG_ID)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) { console.error('lead page error:', error.message); process.exit(1) }
    const rows = (data ?? []) as LeadRow[]
    for (const row of rows) {
      if (row.email_hash && !byEmail.has(row.email_hash)) byEmail.set(row.email_hash, row)
      if (row.phone_hash && !byPhone.has(row.phone_hash)) byPhone.set(row.phone_hash, row)
    }
    process.stderr.write(`  loaded leads: ${from + rows.length}\n`)
    if (rows.length < PAGE) break
  }

  // ---- Fold opportunities into one plan per lead ----
  const plans = new Map<string, LeadPlan>()
  let matched = 0
  let unmatched = 0
  for (const rec of oppRecs) {
    const lead = (rec.emailHash && byEmail.get(rec.emailHash)) || (rec.phoneHash && byPhone.get(rec.phoneHash)) || null
    if (!lead) { unmatched += 1; continue }
    matched += 1
    const existing = plans.get(lead.id)
    const smsDnd = Boolean(rec.target.smsDnd) || Boolean(existing?.smsDnd)
    const allChannelDnd = Boolean(rec.target.allChannelDnd) || Boolean(existing?.allChannelDnd)
    let target = existing?.target ?? rec.target
    if (existing && PRIORITY[rec.target.stageSlug] > PRIORITY[existing.target.stageSlug]) target = rec.target
    plans.set(lead.id, {
      leadId: lead.id,
      currentStageId: lead.stage_id,
      target,
      smsDnd,
      allChannelDnd,
    })
    // stash current consent for apply-phase decisions
    ;(plans.get(lead.id) as LeadPlan & { _lead?: LeadRow })._lead = lead
  }

  // ---- Phase C: tally transitions ----
  const before = new Map<string, number>()
  const after = new Map<string, number>()
  let stageChanges = 0
  let smsSuppress = 0
  let allSuppress = 0
  for (const plan of plans.values()) {
    const fromSlug = plan.currentStageId ? idToSlug.get(plan.currentStageId) ?? '(unknown)' : '(none)'
    const toSlug = plan.target.stageSlug
    before.set(fromSlug, (before.get(fromSlug) ?? 0) + 1)
    after.set(toSlug, (after.get(toSlug) ?? 0) + 1)
    if (slugToId.get(toSlug) !== plan.currentStageId) stageChanges += 1
    if (plan.smsDnd) smsSuppress += 1
    if (plan.allChannelDnd) allSuppress += 1
  }

  // ---- Report ----
  console.log('\n================ GHL -> LI RECONCILE ' + (APPLY ? '(APPLY)' : '(DRY RUN)') + ' ================')
  console.log(`Opportunities fetched:        ${fetched}`)
  console.log(`  - mapped to a target stage: ${oppRecs.length}`)
  console.log(`  - no email/phone:           ${noContact}`)
  console.log(`  - unmapped (skipped):       ${[...unmapped.values()].reduce((a, b) => a + b, 0)}`)
  console.log(`Opp->lead matched:            ${matched}`)
  console.log(`Opp->lead UNMATCHED:          ${unmatched}  (in GHL but no LI lead by email/phone)`)
  console.log(`Distinct LI leads affected:   ${plans.size}`)
  console.log(`  - stage will change:        ${stageChanges}`)
  console.log(`  - SMS-suppress (DND SMS):   ${smsSuppress}`)
  console.log(`  - all-channel suppress:     ${allSuppress}`)

  console.log('\n--- Affected leads: CURRENT stage ---')
  for (const [s, n] of [...before.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${s}`)
  console.log('\n--- Affected leads: RECONCILED stage (projected) ---')
  for (const [s, n] of [...after.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${s}`)

  if (unmapped.size) {
    console.log('\n--- UNMAPPED GHL stages (skipped — no lead touched) ---')
    for (const [k, n] of [...unmapped.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${k}`)
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to reconcile.')
    return
  }

  // ---- Apply ----
  console.log('\nApplying...')

  // Build the minimal op set (only leads that actually change).
  type Op = { leadId: string; update: Record<string, unknown>; stageSlug?: string }
  const ops: Op[] = []
  const activities: Record<string, unknown>[] = []
  for (const plan of plans.values()) {
    const targetStageId = slugToId.get(plan.target.stageSlug)!
    const lead = (plan as LeadPlan & { _lead?: LeadRow })._lead
    const update: Record<string, unknown> = {}
    let stageSlug: string | undefined
    if (targetStageId !== plan.currentStageId) { update.stage_id = targetStageId; stageSlug = plan.target.stageSlug }
    if ((plan.smsDnd || plan.allChannelDnd) && lead?.sms_consent_status !== 'declined') {
      update.sms_consent_status = 'declined'
      update.sms_opt_out = true
      update.sms_consent_source = 'ghl_reconcile'
    }
    if (plan.allChannelDnd) {
      update.email_consent_status = 'declined'
      update.email_opt_out = true
      update.voice_consent_status = 'declined'
      update.voice_opt_out = true
      update.email_consent_source = 'ghl_reconcile'
      update.voice_consent_source = 'ghl_reconcile'
    }
    if (Object.keys(update).length === 0) continue
    ops.push({ leadId: plan.leadId, update, stageSlug })
    if (stageSlug) {
      activities.push({
        organization_id: ORG_ID,
        lead_id: plan.leadId,
        activity_type: 'stage_changed',
        title: 'Stage reconciled from GoHighLevel',
        description: `Set to ${stageSlug}`,
      })
    }
  }
  console.log(`Ops to write: ${ops.length} (activities: ${activities.length})`)

  // Concurrency-pooled lead updates.
  const CONCURRENCY = 20
  let written = 0
  let errors = 0
  let cursor = 0
  async function worker() {
    while (cursor < ops.length) {
      const op = ops[cursor++]
      const { error } = await supabase.from('leads').update(op.update).eq('id', op.leadId)
      if (error) { errors += 1; if (errors <= 10) console.error(`update ${op.leadId}: ${error.message}`) }
      else { written += 1 }
      if (written && written % 2000 === 0) process.stderr.write(`  updated ${written}/${ops.length}...\n`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  console.log(`Lead updates written: ${written}  (errors: ${errors})`)

  // Batch-insert the stage-change activities.
  let acts = 0
  for (const c of chunk(activities, 500)) {
    const { error } = await supabase.from('lead_activities').insert(c)
    if (error) { console.error(`activity batch error: ${error.message}`); continue }
    acts += c.length
  }
  console.log(`Activities logged: ${acts}`)
  console.log('Done.')
}

main().catch((e) => { console.error(e); process.exit(1) })
