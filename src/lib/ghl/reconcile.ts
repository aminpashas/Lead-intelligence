/**
 * GHL -> LI stage reconciliation engine (shared by the one-time backfill script
 * and the recurring cron).
 *
 * GHL is authoritative: every opportunity across the location's pipelines is
 * mapped to an LI stage (src/lib/ghl/reconcile-map) and the matching LI lead is
 * moved to that stage. A person with several opportunities is resolved to their
 * single most-advanced stage (won > active funnel > contacted > lost > new) so
 * a nurture opp can never downgrade a won patient.
 *
 * Reconcile-ONLY: it never creates leads. New GHL contacts arrive in LI via the
 * DGS bridge; this engine only corrects the stage/DND of leads that already
 * exist. Unmapped GHL stages are skipped, never reset to New Lead.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchPipelines, searchOpportunities } from './client'
import { searchHash } from '@/lib/encryption'
import { formatToE164 } from '@/lib/leads/phone'
import { resolveReconcileTarget, type LiStageSlug, type ReconcileTarget } from './reconcile-map'
import type { GhlConfig } from './types'

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

const NATIVE: LiStageSlug[] = [
  'new', 'contacted', 'qualified', 'consultation-scheduled', 'consultation-completed',
  'treatment-presented', 'financing', 'contract-signed', 'scheduled', 'completed', 'lost',
]

/** Operator-requested columns that are find-or-created if absent. */
const PRESERVED: Array<{ slug: LiStageSlug; name: string }> = [
  { slug: 'no-communication', name: 'No Communication' },
  { slug: 'dnd-sms', name: 'DND SMS' },
]

/**
 * GHL stages that merely mean "not worked yet". They must never OVERRIDE a lead
 * LI has genuinely engaged: a GHL opp sitting in "No Communication" is stale the
 * moment LI sends the first text or places the first call. Won/lost/DND and real
 * funnel stages still apply — only these non-advancing buckets are guarded.
 */
const DEMOTING_SLUGS: ReadonlySet<LiStageSlug> = new Set(['no-communication', 'new'])

/** Engagement signals carried on the lead row (cheap — no join). */
export type LeadEngagement = {
  status: string | null
  total_messages_sent: number | null
  total_messages_received: number | null
  last_contacted_at: string | null
  last_responded_at: string | null
}

/**
 * True when LI has real two-way activity on the lead: any message sent/received,
 * a contact/response timestamp, or a status past intake. Pure so the guard is
 * unit-testable without GHL/DB I/O.
 */
export function hasLiEngagement(lead: LeadEngagement): boolean {
  if (lead.status && lead.status !== 'new') return true
  if ((lead.total_messages_sent ?? 0) + (lead.total_messages_received ?? 0) > 0) return true
  return Boolean(lead.last_contacted_at || lead.last_responded_at)
}

export type ReconcileReport = {
  status: 'ok' | 'skipped'
  fetched: number
  mapped: number
  noContact: number
  unmapped: number
  matched: number
  unmatched: number
  leadsAffected: number
  stageChanges: number
  smsSuppressed: number
  allChannelSuppressed: number
  /** won/lost/closed leads pulled out of active campaign enrollments. */
  outreachSuppressed: number
  /** stage slug -> projected/applied count, for observability. */
  afterDistribution: Record<string, number>
}

type LeadRow = {
  id: string
  stage_id: string | null
  sms_consent_status: string | null
  email_hash: string | null
  phone_hash: string | null
} & LeadEngagement

type LeadPlan = {
  leadId: string
  currentStageId: string | null
  smsCurrent: string | null
  target: ReconcileTarget
  smsDnd: boolean
  allChannelDnd: boolean
  /** LI has real activity — a stale GHL "No Communication"/"New" must not win. */
  engaged: boolean
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Load slug->id, find-or-creating the two preserved columns (unless dryRun). */
async function loadStageMap(
  supabase: SupabaseClient,
  organizationId: string,
  dryRun: boolean,
): Promise<Map<string, string>> {
  const load = async () => {
    const { data } = await supabase
      .from('pipeline_stages')
      .select('id, slug, position')
      .eq('organization_id', organizationId)
    return (data ?? []) as Array<{ id: string; slug: string; position: number | null }>
  }
  let rows = await load()
  const slugToId = new Map<string, string>()
  for (const r of rows) slugToId.set(r.slug, r.id)

  const missingNative = NATIVE.filter((s) => !slugToId.has(s))
  if (missingNative.length) throw new Error(`Missing native LI stages: ${missingNative.join(', ')}`)

  const toCreate = PRESERVED.filter((p) => !slugToId.has(p.slug))
  if (toCreate.length && !dryRun) {
    let pos = Math.max(0, ...rows.map((r) => r.position ?? 0)) + 1
    await supabase.from('pipeline_stages').insert(
      toCreate.map((p) => ({ organization_id: organizationId, name: p.name, slug: p.slug, position: pos++ })),
    )
    rows = await load()
    slugToId.clear()
    for (const r of rows) slugToId.set(r.slug, r.id)
  }
  return slugToId
}

export async function reconcileGhlStages(
  supabase: SupabaseClient,
  organizationId: string,
  config: GhlConfig,
  opts: { dryRun?: boolean; log?: (msg: string) => void } = {},
): Promise<ReconcileReport> {
  const dryRun = opts.dryRun ?? false
  const log = opts.log ?? (() => {})

  const slugToId = await loadStageMap(supabase, organizationId, dryRun)

  // Reconcile ALL pipelines in the location. A stage reconcile only ever maps
  // onto leads that already exist (unmapped stages + unmatched opps are skipped),
  // so there is no downside to full coverage — and it avoids the single-vs-list
  // `pipeline_id` filtering that historically made the sync a silent no-op.
  const targets = await fetchPipelines(config)
  if (targets.length === 0) {
    return {
      status: 'skipped', fetched: 0, mapped: 0, noContact: 0, unmapped: 0, matched: 0,
      unmatched: 0, leadsAffected: 0, stageChanges: 0, smsSuppressed: 0, allChannelSuppressed: 0,
      outreachSuppressed: 0, afterDistribution: {},
    }
  }

  // ---- Phase A: read every opportunity, key by contact hash ----
  type OppRec = { emailHash: string | null; phoneHash: string | null; target: ReconcileTarget }
  const oppRecs: OppRec[] = []
  let fetched = 0
  let noContact = 0
  let unmapped = 0

  for (const pipeline of targets) {
    const stageName = new Map<string, string>()
    for (const st of pipeline.stages ?? []) stageName.set(st.id, st.name)

    let startAfter: string | undefined
    let startAfterId: string | undefined
    for (let guard = 0; guard < 5000; guard++) {
      const page = await searchOpportunities(config, { pipelineId: pipeline.id, startAfter, startAfterId })
      for (const opp of page.opportunities) {
        fetched += 1
        const sName = opp.pipelineStageId ? stageName.get(opp.pipelineStageId) : undefined
        const target = resolveReconcileTarget(sName, opp.status)
        if (!target) { unmapped += 1; continue }
        const email = opp.contact?.email?.trim() || null
        const phoneFormatted = opp.contact?.phone ? formatToE164(opp.contact.phone.trim()) : null
        const emailHash = email ? searchHash(email) : null
        const phoneHash = phoneFormatted ? searchHash(phoneFormatted) : null
        if (!emailHash && !phoneHash) { noContact += 1; continue }
        oppRecs.push({ emailHash, phoneHash, target })
      }
      if (!page.nextStartAfter || !page.nextStartAfterId) break
      startAfter = page.nextStartAfter
      startAfterId = page.nextStartAfterId
    }
    log(`swept "${pipeline.name}" (opps so far: ${fetched})`)
  }

  // ---- Phase B: load all org leads once, index by hash ----
  const byEmail = new Map<string, LeadRow>()
  const byPhone = new Map<string, LeadRow>()
  const SELECT =
    'id, stage_id, sms_consent_status, email_hash, phone_hash, status, total_messages_sent, total_messages_received, last_contacted_at, last_responded_at'
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('leads')
      .select(SELECT)
      .eq('organization_id', organizationId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`lead page error: ${error.message}`)
    const rows = (data ?? []) as LeadRow[]
    for (const row of rows) {
      if (row.email_hash && !byEmail.has(row.email_hash)) byEmail.set(row.email_hash, row)
      if (row.phone_hash && !byPhone.has(row.phone_hash)) byPhone.set(row.phone_hash, row)
    }
    if (rows.length < PAGE) break
  }

  // ---- Fold opportunities into one plan per lead (priority-resolved) ----
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
      smsCurrent: lead.sms_consent_status,
      target,
      smsDnd,
      allChannelDnd,
      engaged: hasLiEngagement(lead),
    })
  }

  // ---- Phase C: compute the write set ----
  type Op = { leadId: string; update: Record<string, unknown>; stageSlug?: string }
  const ops: Op[] = []
  const activities: Record<string, unknown>[] = []
  const afterDistribution: Record<string, number> = {}
  let stageChanges = 0
  let smsSuppressed = 0
  let allChannelSuppressed = 0
  // Leads reconciled to a won/lost/closed target — pull them out of any active
  // campaign enrollment so a closed patient stops getting "still interested?"
  // nurture drips. (Previously the map computed target.suppressOutreach but no
  // consumer ever read it; the docstring promised a guarantee the code didn't keep.)
  const suppressLeadIds = new Set<string>()

  for (const plan of plans.values()) {
    if (plan.target.suppressOutreach || plan.allChannelDnd) suppressLeadIds.add(plan.leadId)
    // A stale GHL "No Communication"/"New" must not overwrite a lead LI has
    // already engaged — LI activity wins. DND/consent writes below still apply.
    const demotesEngaged = DEMOTING_SLUGS.has(plan.target.stageSlug) && plan.engaged
    afterDistribution[plan.target.stageSlug] = (afterDistribution[plan.target.stageSlug] ?? 0) + 1
    const targetStageId = slugToId.get(plan.target.stageSlug)
    const update: Record<string, unknown> = {}
    let stageSlug: string | undefined
    if (targetStageId && targetStageId !== plan.currentStageId && !demotesEngaged) {
      update.stage_id = targetStageId
      stageSlug = plan.target.stageSlug
      stageChanges += 1
    }
    if ((plan.smsDnd || plan.allChannelDnd) && plan.smsCurrent !== 'declined') {
      update.sms_consent_status = 'declined'
      update.sms_opt_out = true
      update.sms_consent_source = 'ghl_reconcile'
      smsSuppressed += 1
    }
    if (plan.allChannelDnd) {
      update.email_consent_status = 'declined'
      update.email_opt_out = true
      update.voice_consent_status = 'declined'
      update.voice_opt_out = true
      update.email_consent_source = 'ghl_reconcile'
      update.voice_consent_source = 'ghl_reconcile'
      allChannelSuppressed += 1
    }
    if (Object.keys(update).length === 0) continue
    ops.push({ leadId: plan.leadId, update, stageSlug })
    if (stageSlug) {
      activities.push({
        organization_id: organizationId,
        lead_id: plan.leadId,
        activity_type: 'stage_changed',
        title: 'Stage reconciled from GoHighLevel',
        description: `Set to ${stageSlug}`,
      })
    }
  }

  const report: ReconcileReport = {
    status: 'ok',
    fetched,
    mapped: oppRecs.length,
    noContact,
    unmapped,
    matched,
    unmatched,
    leadsAffected: plans.size,
    stageChanges,
    smsSuppressed,
    allChannelSuppressed,
    outreachSuppressed: suppressLeadIds.size,
    afterDistribution,
  }
  if (dryRun) return report

  // ---- Apply: concurrency-pooled updates + batched activities ----
  const CONCURRENCY = 20
  let cursor = 0
  const worker = async () => {
    while (cursor < ops.length) {
      const op = ops[cursor++]
      const { error } = await supabase.from('leads').update(op.update).eq('id', op.leadId)
      if (error) log(`update ${op.leadId} failed: ${error.message}`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  for (const c of chunk(activities, 500)) {
    await supabase.from('lead_activities').insert(c)
  }

  // Honor suppressOutreach: exit active/paused campaign enrollments for won/lost/
  // closed leads so they drop out of nurture drips. Batched by lead-id chunk.
  if (suppressLeadIds.size > 0) {
    for (const c of chunk(Array.from(suppressLeadIds), 200)) {
      const { error } = await supabase
        .from('campaign_enrollments')
        .update({ status: 'exited', completed_at: new Date().toISOString() })
        .in('lead_id', c)
        .in('status', ['active', 'paused'])
      if (error) log(`suppress outreach for ${c.length} leads failed: ${error.message}`)
    }
  }

  return report
}
