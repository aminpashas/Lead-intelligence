/**
 * Promote leads that are stuck in the "New Lead" stage but that LI has already
 * engaged. A lead LI has texted, called, or booked a consult for is not "new" —
 * yet nothing promotes OUT of New Lead on its own:
 *
 *   - The GHL reconcile (src/lib/ghl/reconcile) only ever PREVENTS demotion of an
 *     engaged lead (its guard); it never advances one that GHL still parks in
 *     "New Lead" / "No Communication".
 *   - The outbound send-paths bump total_messages_sent / last_contacted_at but
 *     are scattered and do not advance stage_id.
 *
 * So without this pass, contacted leads accumulate in New Lead indefinitely and
 * the column stops meaning "new".
 *
 * LI-truth driven and GHL-INDEPENDENT: it keys off the lead's own status and
 * activity, so it corrects both GHL-linked leads and LI-only leads (e.g. the
 * WhatConverts inbound cohort) that the GHL reconcile never sees. Idempotent —
 * a lead already promoted is skipped on the next run.
 *
 * It never DEmotes and never touches consent: the only move is New Lead -> a
 * more-advanced stage the lead's own status/engagement already justifies.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type UnstaleReport = {
  status: 'ok' | 'skipped'
  toContacted: number
  toConsultationScheduled: number
  toConsultationCompleted: number
  /** reason when skipped (e.g. the org has no New Lead stage) */
  reason?: string
}

type MovedRow = { id: string }

/** PostgREST `.or()` predicate: the lead shows real LI engagement. */
const ENGAGED_OR =
  'last_contacted_at.not.is.null,last_responded_at.not.is.null,total_messages_sent.gt.0,total_messages_received.gt.0'

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
