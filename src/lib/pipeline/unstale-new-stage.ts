/**
 * Keep the "New Lead" stage honest. A lead is only "new" if LI has not worked it
 * AND it actually arrived recently; nothing else moves leads OUT of New Lead on
 * its own:
 *
 *   - The GHL reconcile (src/lib/ghl/reconcile) only ever PREVENTS demotion of an
 *     engaged lead (its guard); it never advances one that GHL still parks in
 *     "New Lead" / "No Communication".
 *   - The outbound send-paths bump total_messages_sent / last_contacted_at but
 *     are scattered and do not advance stage_id.
 *
 * Two complementary passes, both LI-truth driven and GHL-INDEPENDENT (they key
 * off the lead's own status/activity/age, so they correct GHL-linked leads and
 * LI-only leads — e.g. the WhatConverts inbound cohort — alike). Both are
 * idempotent; a lead already moved is skipped on the next run.
 *
 *   1. `promoteEngagedNewLeads` — worked leads go FORWARD to the stage their own
 *      engagement already justifies.
 *   2. `parkAgedNewLeads`       — un-worked leads that are simply too OLD to be
 *      called new go SIDEWAYS to the un-worked queue ("No Communication").
 *
 * Neither touches consent.
 *
 * Why pass 2 exists: GHL is stage-authoritative for some orgs, and its intake
 * stages are named "New Lead" even inside a cold nurturing database (the SF
 * "AOX Nurturing Database" pipeline holds 13k such opps). The reconcile faithfully
 * maps those onto LI "New Lead" every run, so a month-old import that nobody ever
 * called reappears as "new" — a one-time SQL sweep gets silently reverted by the
 * next nightly reconcile. Age is the signal the GHL stage name lacks, and it is
 * source-agnostic. Both passes run AFTER the reconcile in `cron/ghl-sync`, so
 * they get the last word instead of fighting it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { UNWORKED_STAGE_SLUG } from '@/lib/leads/intake-routing'

export type UnstaleReport = {
  status: 'ok' | 'skipped'
  toContacted: number
  toConsultationScheduled: number
  toConsultationCompleted: number
  /** reason when skipped (e.g. the org has no New Lead stage) */
  reason?: string
}

export type ParkAgedReport = {
  status: 'ok' | 'skipped'
  /** Leads moved New Lead -> the un-worked queue. */
  parked: number
  /** ISO cutoff used — anything created before this is no longer "new". */
  cutoff: string
  /** reason when skipped (e.g. the org has no New Lead / No Communication stage) */
  reason?: string
}

type MovedRow = { id: string }

/** PostgREST `.or()` predicate: the lead shows real LI engagement. */
const ENGAGED_OR =
  'last_contacted_at.not.is.null,last_responded_at.not.is.null,total_messages_sent.gt.0,total_messages_received.gt.0'

/**
 * De Morgan's inverse of ENGAGED_OR, as null-safe `.or()` groups.
 *
 * `NOT (a OR b OR c OR d)` == `(NOT a) AND (NOT b) AND (NOT c) AND (NOT d)`.
 * The two timestamp halves are plain `.is(col, null)` filters; the counters need
 * an or-group each because they are NULLABLE (default 0, but an explicit null is
 * allowed) and `NOT (null > 0)` is NULL in SQL — which would silently drop the
 * very rows we want. Chained `.or()` calls are separate PostgREST params and are
 * therefore ANDed together.
 */
const NOT_ENGAGED_SENT_OR = 'total_messages_sent.is.null,total_messages_sent.eq.0'
const NOT_ENGAGED_RECEIVED_OR = 'total_messages_received.is.null,total_messages_received.eq.0'

/** Default age after which an untouched lead stops counting as "new". */
export const DEFAULT_NEW_LEAD_MAX_AGE_DAYS = 7

/**
 * Leads parked per UPDATE round-trip.
 *
 * Every `leads` UPDATE fires the per-row `audit_row_change` trigger, so a single
 * bulk statement over the whole backlog exceeds the statement timeout and the
 * entire transaction rolls back (a ~1.3k-row sweep already did exactly that, and
 * a 25k-row migration died the same way before it). Chunking keeps each
 * statement well inside the timeout and makes progress durable: an interrupted
 * run keeps the chunks it already committed, and the pass is idempotent, so the
 * next run simply resumes.
 */
export const PARK_CHUNK_SIZE = 200

/**
 * Age (days) after which an un-worked lead is no longer "new". Env-overridable
 * per deployment; falls back to the default on an unset/invalid value.
 */
export function newLeadMaxAgeDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.NEW_LEAD_MAX_AGE_DAYS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_NEW_LEAD_MAX_AGE_DAYS
}

/**
 * Move engaged/consulted leads out of the org's New Lead stage into the stage
 * their own LI status/activity already justifies. Returns per-target counts.
 */
export async function promoteEngagedNewLeads(
  supabase: SupabaseClient,
  organizationId: string,
  opts: { log?: (msg: string) => void } = {},
): Promise<UnstaleReport> {
  const log = opts.log ?? (() => {})

  const { data: stageRows } = await supabase
    .from('pipeline_stages')
    .select('id, slug')
    .eq('organization_id', organizationId)
  const slugToId = new Map<string, string>()
  for (const r of (stageRows ?? []) as Array<{ id: string; slug: string }>) slugToId.set(r.slug, r.id)

  const newId = slugToId.get('new')
  const contactedId = slugToId.get('contacted')
  const consultScheduledId = slugToId.get('consultation-scheduled')
  const consultCompletedId = slugToId.get('consultation-completed')

  // No New Lead / Contacted stage -> nothing this pass can safely do.
  if (!newId || !contactedId) {
    return { status: 'skipped', toContacted: 0, toConsultationScheduled: 0, toConsultationCompleted: 0, reason: 'missing_core_stages' }
  }

  const movedIds: string[] = []

  // 1) Status already says "consultation completed" but stage lags in New Lead.
  let toConsultationCompleted = 0
  if (consultCompletedId) {
    const { data } = await supabase
      .from('leads')
      .update({ stage_id: consultCompletedId })
      .eq('organization_id', organizationId)
      .eq('stage_id', newId)
      .eq('status', 'consultation_completed')
      .select('id')
    const rows = (data ?? []) as MovedRow[]
    toConsultationCompleted = rows.length
    for (const r of rows) movedIds.push(r.id)
  }

  // 2) Status says "consultation scheduled" but stage lags in New Lead.
  let toConsultationScheduled = 0
  if (consultScheduledId) {
    const { data } = await supabase
      .from('leads')
      .update({ stage_id: consultScheduledId })
      .eq('organization_id', organizationId)
      .eq('stage_id', newId)
      .eq('status', 'consultation_scheduled')
      .select('id')
    const rows = (data ?? []) as MovedRow[]
    toConsultationScheduled = rows.length
    for (const r of rows) movedIds.push(r.id)
  }

  // 3) Status is still "new" but LI has real engagement -> at least Contacted.
  const { data: contactedData } = await supabase
    .from('leads')
    .update({ stage_id: contactedId })
    .eq('organization_id', organizationId)
    .eq('stage_id', newId)
    .eq('status', 'new')
    .or(ENGAGED_OR)
    .select('id')
  const contactedRows = (contactedData ?? []) as MovedRow[]
  const toContacted = contactedRows.length
  for (const r of contactedRows) movedIds.push(r.id)

  // Log a stage-change activity per moved lead (chunked).
  if (movedIds.length > 0) {
    const activities = movedIds.map((leadId) => ({
      organization_id: organizationId,
      lead_id: leadId,
      activity_type: 'stage_changed',
      title: 'Stage corrected out of New Lead',
      description: 'Lead had prior contact/consult activity but was stuck in New Lead; realigned to LI engagement truth.',
    }))
    for (let i = 0; i < activities.length; i += 500) {
      await supabase.from('lead_activities').insert(activities.slice(i, i + 500))
    }
  }

  log(`unstale New Lead: contacted=${toContacted} consultScheduled=${toConsultationScheduled} consultCompleted=${toConsultationCompleted}`)
  return { status: 'ok', toContacted, toConsultationScheduled, toConsultationCompleted }
}

/**
 * Park leads that are still sitting in New Lead but are simply too old to be
 * called new, and that nobody ever worked, into the un-worked queue
 * ("No Communication").
 *
 * Deliberately NOT "Nurturing": nurturing means a worked lead that went cold and
 * is being warmed back up. These were never touched — they are un-worked intake,
 * which is exactly what the un-worked queue is for (and where the paid-only
 * intake gate already routes non-paid new leads, so the two agree).
 *
 * Safety: only ever moves a lead that is un-worked on EVERY signal LI has
 * (`ENGAGED_OR`'s inverse) and whose status is still the untouched default
 * 'new'. A lead with any contact, any message, or an advanced status is left
 * alone for `promoteEngagedNewLeads` to move forward instead — so the two passes
 * partition New Lead rather than fight over it, in either order.
 *
 * Idempotent: a parked lead is no longer in New Lead, so the next run skips it.
 */
export async function parkAgedNewLeads(
  supabase: SupabaseClient,
  organizationId: string,
  opts: {
    log?: (msg: string) => void
    maxAgeDays?: number
    now?: Date
    chunkSize?: number
  } = {},
): Promise<ParkAgedReport> {
  const log = opts.log ?? (() => {})
  const maxAgeDays = opts.maxAgeDays ?? newLeadMaxAgeDays()
  const now = opts.now ?? new Date()
  const chunkSize = opts.chunkSize ?? PARK_CHUNK_SIZE
  const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString()

  const { data: stageRows } = await supabase
    .from('pipeline_stages')
    .select('id, slug')
    .eq('organization_id', organizationId)
  const slugToId = new Map<string, string>()
  for (const r of (stageRows ?? []) as Array<{ id: string; slug: string }>) slugToId.set(r.slug, r.id)

  const newId = slugToId.get('new')
  const unworkedId = slugToId.get(UNWORKED_STAGE_SLUG)

  // Without both stages there is nowhere safe to move to — do nothing.
  if (!newId || !unworkedId) {
    return { status: 'skipped', parked: 0, cutoff, reason: 'missing_core_stages' }
  }

  let parked = 0

  // Chunked: select a batch of matching ids, then update just those. A parked
  // lead leaves New Lead, so it can no longer match — the next iteration walks
  // naturally onto the next batch with no offset bookkeeping.
  for (let guard = 0; guard < 1000; guard++) {
    const { data: batch, error: selectError } = await supabase
      .from('leads')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('stage_id', newId)
      .eq('status', 'new')
      .lt('created_at', cutoff)
      .is('last_contacted_at', null)
      .is('last_responded_at', null)
      .or(NOT_ENGAGED_SENT_OR)
      .or(NOT_ENGAGED_RECEIVED_OR)
      .limit(chunkSize)

    // Never swallow these: a silent failure here looks identical to "nothing was
    // stale", which is exactly the state this pass exists to disprove.
    if (selectError) throw new Error(`parkAgedNewLeads select failed: ${selectError.message}`)

    const ids = ((batch ?? []) as MovedRow[]).map((r) => r.id)
    if (ids.length === 0) break

    const { data: updated, error: updateError } = await supabase
      .from('leads')
      .update({ stage_id: unworkedId })
      .in('id', ids)
      // Re-assert under concurrency: another pass may have moved one already.
      .eq('stage_id', newId)
      .select('id')

    if (updateError) throw new Error(`parkAgedNewLeads update failed: ${updateError.message}`)

    const rows = (updated ?? []) as MovedRow[]
    // Selected rows we could not move means something else owns them now;
    // stop rather than re-selecting the same ids forever.
    if (rows.length === 0) break
    parked += rows.length

    const activities = rows.map((r) => ({
      organization_id: organizationId,
      lead_id: r.id,
      activity_type: 'stage_changed',
      title: 'Aged out of New Lead',
      description: `Never worked and older than ${maxAgeDays}d; moved to the un-worked queue so New Lead only holds genuinely new leads.`,
    }))
    await supabase.from('lead_activities').insert(activities)
  }

  log(`park aged New Lead: parked=${parked} (cutoff ${cutoff}, maxAgeDays=${maxAgeDays})`)
  return { status: 'ok', parked, cutoff }
}
