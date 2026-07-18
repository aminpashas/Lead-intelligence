/**
 * Advance a lead's pipeline BOARD stage (`leads.stage_id`) to "Consultation
 * Scheduled" the moment a real appointment is created.
 *
 * WHY THIS EXISTS
 * ---------------
 * `leads.status` and `leads.stage_id` are two different fields. Every booking
 * surface (the AI `create_booking` tool, the staff appointments UI, the Cal.com
 * webhook, the CareStack EHR sync) sets `status = 'consultation_scheduled'`, but
 * the pipeline BOARD groups leads by `stage_id`. Before this helper, nothing on
 * the booking path moved `stage_id`; the board only caught up later via a batch
 * cron (`promoteEngagedNewLeads`) that ONLY rescued leads still parked in the
 * "new" stage. A lead already in Following Up / Engaged / Qualified who booked a
 * consult therefore stayed in that column indefinitely — the visible status
 * never changed.
 *
 * This closes the gap: on every real booking, advance the board to
 * "Consultation Scheduled" immediately, so the lead's status is visibly correct
 * the same way a hand-dragged move would be (a `stage_changed` activity row is
 * written for the audit trail).
 *
 * SAFETY
 * ------
 *  - Monotonic: never drags a lead backward from a further-along stage, nor out
 *    of a won / lost / off-funnel position (see `shouldAdvanceToConsult`).
 *  - Automations suppressed: entering "Consultation Scheduled" has funnel entry
 *    actions that send a confirmation email + SMS, and every booking surface
 *    already sends its own confirmation. Firing them here would double-text the
 *    patient, so the board move is applied WITHOUT re-firing automations. The
 *    `stage_changed` activity still records the move.
 *  - Fail-soft: a board-sync failure must never break booking confirmation, so
 *    everything is wrapped and errors are logged, never thrown.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { applyStageMove, type StageMoveActor } from '@/lib/pipeline/stage-move'

/** Canonical LI slug for the "Consultation Scheduled" board column. */
export const CONSULT_STAGE_SLUG = 'consultation-scheduled'

/**
 * Slugs at or beyond a booked consultation in the sales/fulfillment funnel. A
 * lead sitting here has already progressed past "Consultation Scheduled", so a
 * new booking must not pull it backward. (Won/lost is handled separately via the
 * pipeline_stages.is_won / is_lost flags, which are more reliable than slugs for
 * custom org boards.)
 */
const AT_OR_PAST_CONSULT = new Set<string>([
  'consultation-scheduled',
  'consultation-completed',
  'treatment-presented',
  'financing',
  'contract-signed',
  'scheduled',
  'completed',
  'lost',
])

/**
 * Off-funnel parking stages (existing patients / caller-ID junk). These are not
 * sales leads; a booking should not silently reclassify them onto the sales
 * board — leave that decision to a human.
 */
const OFF_FUNNEL = new Set<string>(['existing-patient', 'junk'])

/**
 * Pure decision: given a lead's CURRENT stage, should a booking advance it to
 * "Consultation Scheduled"? Extracted so the monotonic guard is unit-testable
 * without a database.
 */
export function shouldAdvanceToConsult(input: {
  currentSlug: string | null
  isWon: boolean
  isLost: boolean
}): boolean {
  const { currentSlug, isWon, isLost } = input
  if (isWon || isLost) return false
  // No stage yet (freshly ingested lead) — a real booking is a strong signal.
  if (!currentSlug) return true
  if (AT_OR_PAST_CONSULT.has(currentSlug)) return false
  if (OFF_FUNNEL.has(currentSlug)) return false
  return true
}

export type AdvanceStageOnBookingParams = {
  organizationId: string
  leadId: string
  /** Provenance tag for the stage_changed activity (e.g. 'booking:ai', 'booking:staff'). */
  source: string
  /** `user_profiles.id` when a human booked it (staff UI); omitted for system paths. */
  userId?: string
}

/**
 * Move the lead to "Consultation Scheduled" on the board if the monotonic guard
 * allows it. Best-effort — never throws. Call AFTER the appointment row and the
 * `leads.status = 'consultation_scheduled'` write, on real-booking paths only.
 */
export async function advanceStageOnBooking(
  supabase: SupabaseClient,
  params: AdvanceStageOnBookingParams
): Promise<void> {
  try {
    const { organizationId, leadId, source, userId } = params

    // The target column for this org. Custom boards may not have it — no-op then.
    const { data: target } = await supabase
      .from('pipeline_stages')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('slug', CONSULT_STAGE_SLUG)
      .maybeSingle()
    if (!target?.id) return

    const { data: lead } = await supabase
      .from('leads')
      .select('stage_id')
      .eq('id', leadId)
      .maybeSingle()
    const currentStageId = (lead?.stage_id as string | null) ?? null
    if (currentStageId === target.id) return // already there

    // Resolve the current stage's slug + won/lost flags for the guard.
    let currentSlug: string | null = null
    let isWon = false
    let isLost = false
    if (currentStageId) {
      const { data: cur } = await supabase
        .from('pipeline_stages')
        .select('slug, is_won, is_lost')
        .eq('id', currentStageId)
        .maybeSingle()
      currentSlug = (cur?.slug as string | null) ?? null
      isWon = !!cur?.is_won
      isLost = !!cur?.is_lost
    }

    if (!shouldAdvanceToConsult({ currentSlug, isWon, isLost })) return

    const actor: StageMoveActor = {
      type: userId ? 'user' : 'system',
      source,
      ...(userId ? { userId } : {}),
    }

    await applyStageMove(supabase, {
      organizationId,
      leadIds: [leadId],
      toStageId: target.id,
      actor,
      knownFromStageId: currentStageId,
      // Suppress automations: the booking surface already sent its confirmation;
      // firing the consultation-scheduled entry actions would double-text.
      suppressAutomations: true,
      activityTitle: 'Moved to Consultation Scheduled (appointment booked)',
    })
  } catch (err) {
    console.error('[advanceStageOnBooking] failed (non-fatal):', err)
  }
}
