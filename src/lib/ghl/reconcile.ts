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
import { serviceLineFromPipelineName, serviceLineTag } from '@/lib/leads/service-line'
// Single source of truth for the "still new?" window — the guard here and the
// parkAgedNewLeads backstop must agree, or they fight over the same leads.
import { newLeadMaxAgeDays } from '@/lib/pipeline/unstale-new-stage'
import type { GhlConfig } from './types'

/**
 * Most-advanced-wins priority when a lead has multiple opportunities.
 *
 * Only ever compared relatively (`PRIORITY[a] > PRIORITY[b]`), so the absolute
 * values carry no meaning and the ladder can be renumbered freely.
 *
 * 'no-show' sits just BELOW 'consultation-scheduled': a missed consult proves
 * more intent than 'qualified' (they committed to a time), but if another
 * opportunity says the lead is scheduled they have rebooked, and that should win.
 */
export const PRIORITY: Record<LiStageSlug, number> = {
  completed: 15,
  'contract-signed': 14,
  scheduled: 13,
  financing: 12,
  'treatment-presented': 11,
  'consultation-completed': 10,
  'consultation-scheduled': 9,
  'no-show': 8,
  qualified: 7,
  engaged: 6,
  contacted: 5,
  'no-communication': 4,
  'dnd-sms': 3,
  lost: 2,
  new: 1,
}

export const NATIVE: LiStageSlug[] = [
  'new', 'contacted', 'engaged', 'qualified', 'consultation-scheduled', 'consultation-completed',
  'treatment-presented', 'financing', 'contract-signed', 'scheduled', 'completed', 'lost',
]

/** Operator-requested columns that are find-or-created if absent. */
const PRESERVED: Array<{ slug: LiStageSlug; name: string }> = [
  { slug: 'no-communication', name: 'No Communication' },
  { slug: 'dnd-sms', name: 'DND SMS' },
]

/**
 * GHL stages that merely mean "not worked yet" (or, for "contacted", mean
 * "in cadence but no reply"). They must never OVERRIDE a lead LI has genuinely
 * engaged: a GHL opp sitting in "No Communication"/"New" is stale the moment LI
 * sends the first text, and a GHL opp still sitting in a "contacted"-family
 * stage is stale the moment the lead actually replies (LI's 'engaged' stage
 * ranks above 'contacted' in PRIORITY — see above). Won/lost/DND and the real
 * funnel stages beyond contacted still apply — only these non-advancing
 * buckets are guarded.
 */
const DEMOTING_SLUGS: ReadonlySet<LiStageSlug> = new Set(['no-communication', 'new', 'contacted'])

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

/**
 * True when the lead is too old to ever be "new" again.
 *
 * GHL names its intake stage "New Lead" even inside a cold nurturing database
 * (the SF "AOX Nurturing Database" pipeline holds 13k such opps), so a month-old
 * import that nobody ever called still maps to `new` on every sweep. Without this
 * guard the reconcile drags those leads back into New Lead nightly and
 * `parkAgedNewLeads` drags them straight out again — the board ends correct, but
 * every lead collects a bogus stage-change on its timeline every single day.
 *
 * Freshness is LI's fact, not GHL's: `created_at` carries it, the stage name does
 * not. Pure so the guard is unit-testable without GHL/DB I/O.
 */
export function isAgedForNewStage(
  createdAt: string | null,
  now: Date = new Date(),
  maxAgeDays: number = newLeadMaxAgeDays(),
): boolean {
  if (!createdAt) return false // unknown age — never guess a lead is stale
  const t = new Date(createdAt).getTime()
  if (Number.isNaN(t)) return false
  return t < now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000
}

/** Evidence that a lead genuinely has a consult booked ahead — not just a GHL label. */
export type BookingSignal = {
  /** leads.consultation_date; only counts when in the future. */
  consultation_date: string | null
  /** A live appointment row with scheduled_at in the future and not canceled/no-show. */
  hasFutureAppointment: boolean
}

/**
 * True when LI can confirm a real, forward-looking booking. GHL's "appointment
 * scheduled" opp asserts a consult, but the calendar of record is LI's — a claim
 * with no future appointment row and no future consultation_date is unverified
 * (e.g. the 411 SF leads whose only "consult date" is a years-old EHR visit).
 * Pure so the reality-guard is unit-testable without DB I/O.
 */
export function hasRealBooking(signal: BookingSignal, now: Date = new Date()): boolean {
  if (signal.hasFutureAppointment) return true
  if (signal.consultation_date && new Date(signal.consultation_date) > now) return true
  return false
}

/**
 * Reality-guard for the reconcile target. A GHL "consultation-scheduled" claim only
 * stands when a real booking backs it; otherwise it floors to "contacted" (worked,
 * not booked) so the Consultation Scheduled column can't fill with phantom bookings.
 * Every other target passes through untouched. Pure.
 */
export function bookingGuardedSlug(targetSlug: LiStageSlug, realBooking: boolean): LiStageSlug {
  if (targetSlug === 'consultation-scheduled' && !realBooking) return 'contacted'
  return targetSlug
}

/**
 * LI statuses terminal enough to outrank an UNVERIFIED GHL consult claim. A GHL
 * "appointment scheduled" label with no real booking must not reactivate a lead LI
 * has already closed out — a disqualified/completed lead belongs in its own terminal
 * stage, not pulled into Contacted. (A genuine GHL advancement — won/lost — is not
 * routed through here, so it still wins.)
 */
const TERMINAL_STATUS_STAGE: Record<string, LiStageSlug> = {
  disqualified: 'lost',
  lost: 'lost',
  consultation_completed: 'consultation-completed',
  completed: 'completed',
}

/**
 * Full reconcile destination for a GHL target: booking-guard first, then — only when
 * the consult claim was unverified — let a terminal LI status win over the Contacted
 * floor. A real forward booking (realBooking) always keeps the lead in
 * consultation-scheduled, even if LI had previously marked them terminal (they rebooked).
 * Pure so the whole decision is unit-testable without I/O.
 */
export function reconciledSlug(
  ghlSlug: LiStageSlug,
  realBooking: boolean,
  liStatus: string | null,
): LiStageSlug {
  if (ghlSlug === 'consultation-scheduled' && !realBooking) {
    const terminal = liStatus ? TERMINAL_STATUS_STAGE[liStatus] : undefined
    if (terminal) return terminal
  }
  return bookingGuardedSlug(ghlSlug, realBooking)
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
  /** Service-line tags stamped onto leads from their GHL pipeline name. */
  serviceTagsStamped: number
  /** stage slug -> projected/applied count, for observability. */
  afterDistribution: Record<string, number>
}

type LeadRow = {
  id: string
  stage_id: string | null
  sms_consent_status: string | null
  email_hash: string | null
  phone_hash: string | null
  consultation_date: string | null
  created_at: string | null
  tags: string[] | null
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
  /** Older than the "new" window — GHL must not resurrect it into New Lead. */
  aged: boolean
  /** LI can confirm a forward booking — an unverified GHL consult claim floors to contacted. */
  realBooking: boolean
  /** LI lifecycle status — a terminal status outranks an unverified GHL consult claim. */
  liStatus: string | null
  /** The lead's current tags — to append service tags idempotently. */
  currentTags: string[]
  /** Service-line tags derived from the lead's GHL pipeline(s), union across opps. */
  serviceTags: Set<string>
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
      serviceTagsStamped: 0, afterDistribution: {},
    }
  }

  // ---- Phase A: read every opportunity, key by contact hash ----
  // Also capture the treatment (service line) the opp's PIPELINE encodes — GHL
  // models each treatment as its own pipeline (AOX Nurturing Database, Full-Arch
  // Leads, …). The stage map otherwise discards it; we stamp it as a tag so the
  // historical book gains precise treatment attribution going forward.
  type OppRec = {
    emailHash: string | null
    phoneHash: string | null
    target: ReconcileTarget
    serviceTag: string | null
  }
  const oppRecs: OppRec[] = []
  let fetched = 0
  let noContact = 0
  let unmapped = 0

  for (const pipeline of targets) {
    const stageName = new Map<string, string>()
    for (const st of pipeline.stages ?? []) stageName.set(st.id, st.name)
    // One derivation per pipeline: name -> service key -> canonical tag (or null).
    const pipelineService = serviceLineFromPipelineName(pipeline.name)
    const pipelineServiceTag = pipelineService ? serviceLineTag(pipelineService) : null

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
        oppRecs.push({ emailHash, phoneHash, target, serviceTag: pipelineServiceTag })
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
    'id, stage_id, sms_consent_status, email_hash, phone_hash, consultation_date, created_at, status, total_messages_sent, total_messages_received, last_contacted_at, last_responded_at, tags'
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

  // ---- Booking signal: which leads have a REAL forward appointment ----
  // GHL only carries the label "appointment scheduled"; the calendar of record is
  // LI's. A future, non-canceled appointment row is the ground truth that a consult
  // is actually booked. Tiny table (bookings only land here via LI's own paths), so
  // one indexed sweep keyed by lead_id is cheap.
  const leadsWithFutureAppt = new Set<string>()
  {
    const nowIso = new Date().toISOString()
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('appointments')
        .select('lead_id')
        .eq('organization_id', organizationId)
        .gt('scheduled_at', nowIso)
        .not('status', 'in', '(canceled,no_show)')
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) throw new Error(`appointment page error: ${error.message}`)
      const rows = (data ?? []) as Array<{ lead_id: string | null }>
      for (const r of rows) if (r.lead_id) leadsWithFutureAppt.add(r.lead_id)
      if (rows.length < PAGE) break
    }
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
    // Union the service tags across every opp for this person (a lead can sit in
    // more than one treatment pipeline — e.g. AOX and TMJ — and belongs to both).
    const serviceTags = existing?.serviceTags ?? new Set<string>()
    if (rec.serviceTag) serviceTags.add(rec.serviceTag)
    plans.set(lead.id, {
      leadId: lead.id,
      currentStageId: lead.stage_id,
      smsCurrent: lead.sms_consent_status,
      target,
      smsDnd,
      allChannelDnd,
      engaged: hasLiEngagement(lead),
      aged: isAgedForNewStage(lead.created_at),
      realBooking: hasRealBooking({
        consultation_date: lead.consultation_date,
        hasFutureAppointment: leadsWithFutureAppt.has(lead.id),
      }),
      liStatus: lead.status,
      currentTags: lead.tags ?? [],
      serviceTags,
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
  let serviceTagsStamped = 0

  for (const plan of plans.values()) {
    // A stale GHL "No Communication"/"New" must not overwrite a lead LI has
    // already engaged — LI activity wins. DND/consent writes below still apply.
    const demotesEngaged = DEMOTING_SLUGS.has(plan.target.stageSlug) && plan.engaged
    // Reality-guard: a GHL "appointment scheduled" claim with no forward booking in
    // LI floors to "contacted" so Consultation Scheduled only holds real bookings —
    // and a terminal LI status (disqualified/completed) is routed to its own stage
    // rather than reactivated into Contacted.
    const effectiveSlug = reconciledSlug(plan.target.stageSlug, plan.realBooking, plan.liStatus)
    afterDistribution[effectiveSlug] = (afterDistribution[effectiveSlug] ?? 0) + 1
    const targetStageId = slugToId.get(effectiveSlug)
    // GHL's intake stage is named "New Lead" even inside a cold nurturing
    // database, so it keeps re-asserting "new" on months-old imports. Freshness
    // is LI's fact (created_at), not GHL's stage name: never let a sweep
    // resurrect an aged lead into New Lead. Without this the reconcile and
    // parkAgedNewLeads tug the same rows back and forth every night.
    const resurrectsAged = effectiveSlug === 'new' && plan.aged
    const update: Record<string, unknown> = {}
    let stageSlug: string | undefined
    if (targetStageId && targetStageId !== plan.currentStageId && !demotesEngaged && !resurrectsAged) {
      update.stage_id = targetStageId
      stageSlug = effectiveSlug
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
    // Idempotently stamp the treatment tag(s) the lead's GHL pipeline(s) encode.
    // Only writes when a tag is genuinely missing, so re-runs are no-ops.
    const missingTags = [...plan.serviceTags].filter((t) => !plan.currentTags.includes(t))
    if (missingTags.length) {
      update.tags = [...plan.currentTags, ...missingTags]
      serviceTagsStamped += missingTags.length
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
    serviceTagsStamped,
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

  return report
}
