/**
 * Prospecting guard — stop net-new / top-of-funnel campaigns from messaging a
 * lead who is already booked or further along.
 *
 * WHY THIS EXISTS
 * ---------------
 * Campaign targeting keys off `leads.status`, but in GHL-migrated orgs that
 * field is frozen at `'new'` for essentially every lead — the live lifecycle
 * lives in `leads.stage_id` (the board column: "Consultation Scheduled",
 * "Contract Signed", …). A "New Leads — … (AI Setter)" campaign therefore keeps
 * seeing a booked patient as a fresh lead and fires first-touch outreach
 * ("we just got your request — want to set up a consult?") at someone who
 * already has a consult on the calendar, or has even signed a contract.
 *
 * The fix is a STAGE-aware gate applied at both layers (enrollment audience +
 * per-send executor): a lead whose board stage is at-or-past a booked consult is
 * suppressed from prospecting campaigns. A campaign that legitimately targets
 * booked/later leads opts back in by naming those stages/statuses in its
 * criteria (see `campaignOptsIntoBookedStages`), so nurture / reactivation /
 * later-stage campaigns are unaffected.
 */

import type { SmartListCriteria } from '@/types/database'
import { AT_OR_PAST_CONSULT, isAtOrPastConsultStage } from '@/lib/pipeline/booking-stage'

export { isAtOrPastConsultStage }

/** Board stage slugs that mean "booked a consult or beyond" (or lost). */
export const AT_OR_PAST_CONSULT_SLUGS: readonly string[] = [...AT_OR_PAST_CONSULT]

/**
 * `leads.status` values that correspond to a booked-or-beyond lead. Used only to
 * detect a campaign that *intends* to target such leads (opt-in) — the actual
 * suppression decision is made on the live board stage, not this frozen field.
 */
export const BOOKED_OR_LATER_STATUSES = new Set<string>([
  'consultation_scheduled',
  'consultation_completed',
  'treatment_presented',
  'financing',
  'contract_sent',
  'contract_signed',
  'scheduled',
  'in_treatment',
  'completed',
])

/**
 * Does this campaign explicitly target booked/later-stage leads? Such a campaign
 * (post-consult nurture, a "Contract Signed → onboarding" flow, etc.) opts OUT
 * of the prospecting guard so it can keep reaching those leads on purpose.
 *
 * A campaign opts in when its criteria name any at-or-past-consult board stage
 * (`stages`) or any booked/later lead status (`statuses`). Prospecting campaigns
 * name neither (they target `statuses: ['new']` / a service line), so they stay
 * guarded.
 */
export function campaignOptsIntoBookedStages(criteria: SmartListCriteria | null | undefined): boolean {
  if (!criteria) return false

  const stages = Array.isArray(criteria.stages) ? criteria.stages : []
  if (stages.some((s) => AT_OR_PAST_CONSULT.has(s))) return true

  const statuses = Array.isArray(criteria.statuses) ? criteria.statuses : []
  if (statuses.some((s) => BOOKED_OR_LATER_STATUSES.has(s))) return true

  return false
}

/**
 * Pure decision: should a prospecting campaign suppress this lead? True when the
 * lead's live board stage is at-or-past a booked consult AND the campaign has not
 * opted into booked/later leads.
 */
export function shouldSuppressBookedLead(input: {
  stageSlug: string | null | undefined
  criteria: SmartListCriteria | null | undefined
}): boolean {
  return isAtOrPastConsultStage(input.stageSlug) && !campaignOptsIntoBookedStages(input.criteria)
}
