/**
 * Move a lead's pipeline BOARD stage (`leads.stage_id`) to "No-Show" the moment
 * a consultation is marked as missed.
 *
 * WHY THIS EXISTS
 * ---------------
 * Exactly the `leads.status` vs. `leads.stage_id` split that
 * `advanceStageOnBooking` fixed on the way IN, unfixed on the way OUT. Marking
 * an appointment `no_show` set `status = 'no_show'` and incremented
 * `no_show_count`, but nothing touched `stage_id` — so the lead stayed in
 * "Consultation Scheduled", indistinguishable on the board from a patient whose
 * appointment is still upcoming. The `no_show_rate` KPI counted them correctly
 * the whole time, which is why this stayed invisible: the number was right while
 * the work queue was wrong.
 *
 * Enrollment in the recovery sequence is NOT done here — it runs through the
 * `appointment_no_show` trigger campaign (lib/campaigns/no-show-recovery.ts) so
 * there is exactly one enrollment path. This helper only owns the board.
 *
 * SAFETY
 * ------
 *  - Consultations only. A missed treatment/follow-up visit still bumps status
 *    and no_show_count, but must NOT yank a signed patient out of the
 *    fulfillment funnel and back onto the sales board (see `shouldMoveToNoShow`
 *    and the `type === 'consultation'` check at the call sites).
 *  - Never moves a won / lost / off-funnel / post-close lead.
 *  - Automations suppressed: the trigger campaign is the enrollment path, and
 *    firing stage-entry rules here as well would risk double-enrolling into the
 *    recovery sequence. The `stage_changed` activity still records the move.
 *  - Fail-soft: a board-sync failure must never break the no-show write (which
 *    also drives the fee capture and the EHR cancel), so everything is wrapped
 *    and errors are logged, never thrown.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { applyStageMove, type StageMoveActor } from '@/lib/pipeline/stage-move'
import { NO_SHOW_STAGE_SLUG } from '@/lib/pipeline/stage-groups'

export { NO_SHOW_STAGE_SLUG }

/**
 * Post-close / fulfillment slugs. A lead here has already signed; a missed
 * appointment is a scheduling problem for Dion Clinical, not a sales-board
 * regression. Leave them where they are.
 */
const POST_CLOSE = new Set<string>(['contract-signed', 'scheduled', 'completed'])

/**
 * Deep-funnel slugs where a human is actively working the deal.
 *
 * The No-Show queue exists to surface leads NOBODY is working. A patient sitting
 * in Treatment Presented or Financing has a rep mid-negotiation — often a live
 * lender application — and pulling their card into a triage queue would both
 * lose that context on the board and hand them to whoever works the queue next.
 * The missed appointment is still recorded on the lead (`no_show_count`,
 * `status`), and the rep who owns them will see it there.
 *
 * Consequence, stated plainly: a deep-funnel no-show does NOT enter the recovery
 * sequence, because enrollment is gated on the same guard at the call sites. That
 * is intentional — a generic "want to grab another time?" text would cut across a
 * rep's active financing conversation.
 */
const ACTIVELY_WORKED = new Set<string>(['treatment-presented', 'financing'])

/**
 * Off-funnel parking stages (existing patients / caller-ID junk) — not sales
 * leads, so a missed appointment must not reclassify them onto the sales board.
 */
const OFF_FUNNEL = new Set<string>(['existing-patient', 'junk'])

/**
 * Pure decision: given a lead's CURRENT stage, should a missed consultation move
 * it to "No-Show"? Extracted so the guard is unit-testable without a database.
 */
export function shouldMoveToNoShow(input: {
  currentSlug: string | null
  isWon: boolean
  isLost: boolean
}): boolean {
  const { currentSlug, isWon, isLost } = input
  if (isWon || isLost) return false
  // Already in the no-show queue (a repeat no-show) — nothing to move.
  if (currentSlug === NO_SHOW_STAGE_SLUG) return false
  if (!currentSlug) return true
  if (POST_CLOSE.has(currentSlug)) return false
  if (ACTIVELY_WORKED.has(currentSlug)) return false
  if (OFF_FUNNEL.has(currentSlug)) return false
  return true
}

export type MoveToNoShowParams = {
  organizationId: string
  leadId: string
  /** Provenance tag for the stage_changed activity (e.g. 'no_show:staff', 'no_show:ehr'). */
  source: string
  /** `user_profiles.id` when a human marked it (staff UI); omitted for system paths. */
  userId?: string
}

export type MoveToNoShowResult = {
  /**
   * The lead passed the guard — this no-show is one we act on.
   *
   * Callers gate RECOVERY ENROLLMENT on this, not on `moved`, so the two stay in
   * lockstep: a deep-funnel lead is neither moved nor texted, while an org whose
   * custom board lacks the No-Show column still gets the rebooking sequence.
   */
  eligible: boolean
  /** The board card actually changed columns. False when the org has no No-Show stage. */
  moved: boolean
}

/**
 * Move the lead to "No-Show" on the board if the guard allows it, and report the
 * decision so callers can gate recovery enrollment on the same answer.
 * Best-effort — never throws. Call AFTER the `leads.status = 'no_show'` write,
 * and only for missed CONSULTATIONS.
 */
export async function moveLeadToNoShowStage(
  supabase: SupabaseClient,
  params: MoveToNoShowParams
): Promise<MoveToNoShowResult> {
  try {
    const { organizationId, leadId, source, userId } = params

    const { data: lead } = await supabase
      .from('leads')
      .select('stage_id')
      .eq('id', leadId)
      .maybeSingle()
    const currentStageId = (lead?.stage_id as string | null) ?? null

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

    // Eligibility is resolved BEFORE the target column is looked up, so an org
    // with a custom board that has no No-Show stage still enrolls in recovery
    // instead of silently losing it along with the move.
    if (!shouldMoveToNoShow({ currentSlug, isWon, isLost })) {
      return { eligible: false, moved: false }
    }

    // The target column for this org. Custom boards may not have it — no-op then.
    const { data: target } = await supabase
      .from('pipeline_stages')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('slug', NO_SHOW_STAGE_SLUG)
      .maybeSingle()
    if (!target?.id) return { eligible: true, moved: false }

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
      // The appointment_no_show trigger campaign owns enrollment; firing stage
      // automations here too would risk a second enrollment into recovery.
      suppressAutomations: true,
      activityTitle: 'Moved to No-Show (missed consultation)',
    })
    return { eligible: true, moved: true }
  } catch (err) {
    console.error('[moveLeadToNoShowStage] failed (non-fatal):', err)
    // A board failure must not also suppress recovery — the sequence is the part
    // the patient actually experiences. Report eligible so enrollment proceeds.
    return { eligible: true, moved: false }
  }
}
