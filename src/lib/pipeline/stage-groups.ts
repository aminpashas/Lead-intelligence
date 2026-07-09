/**
 * Stage grouping — which pipeline_stages belong to the *sales* funnel vs. the
 * *post-close* fulfillment funnel vs. *operational* work-queue columns.
 *
 * The board's columns come straight from the pipeline_stages table, but not all
 * stages are the same KIND of thing:
 *
 *   - SALES stages track a deal moving toward the close (new → … → financing).
 *   - POST-CLOSE stages are fulfillment: the deal is already won and the patient
 *     is heading to surgery. These clutter the sales pipeline and get their own
 *     board (/post-close). The close moment is `contract-signed`.
 *   - OPERATIONAL stages are work-queue buckets, not funnel positions. A lead can
 *     be un-worked ("No Communication") or SMS-suppressed ("DND SMS") regardless
 *     of its sales status. Because status is orthogonal here, the sales-oriented
 *     `status NOT IN (disqualified, lost)` count filter must NOT apply to them —
 *     doing so hid 8k never-contacted leads from "No Communication".
 *
 * Slugs are the canonical LI stage slugs (see ghl/reconcile-map.ts LiStageSlug).
 */

/** Fulfillment stages — shown on /post-close, hidden from the sales /pipeline. */
export const POST_CLOSE_STAGE_SLUGS = ['contract-signed', 'scheduled', 'completed'] as const

/**
 * OFF-FUNNEL parking stages — records that are NOT sales leads and must never
 * appear on the sales /pipeline or in the default /leads view:
 *
 *   - `existing-patient`: an inbound contact matching the CareStack patient
 *     mirror (an existing patient calling a tracked number). Owned by Dion Desk
 *     per the ecosystem matrix; parked here (not dropped) until Desk can receive
 *     it, and mirrored to Desk via the dion_desk_outbox.
 *   - `junk`: caller-ID noise (city/state strings, carrier placeholders) with no
 *     reachable contact — see lib/leads/junk-contact.ts.
 *
 * These are the buckets the ingestion reorder routes non-leads into instead of
 * the default "New Lead" stage.
 */
export const OFF_FUNNEL_STAGE_SLUGS = ['existing-patient', 'junk'] as const

const OFF_FUNNEL = new Set<string>(OFF_FUNNEL_STAGE_SLUGS)

/** True for parking stages that hold non-leads (existing patients / junk calls). */
export function isOffFunnelStage(slug: string | null | undefined): boolean {
  return !!slug && OFF_FUNNEL.has(slug)
}

/**
 * Work-queue columns whose population is orthogonal to sales status. Their
 * column counts reflect the TRUE stage population (no disqualified/lost filter).
 */
export const OPERATIONAL_STAGE_SLUGS = ['no-communication', 'dnd-sms', 'nurturing'] as const

const POST_CLOSE = new Set<string>(POST_CLOSE_STAGE_SLUGS)
const OPERATIONAL = new Set<string>(OPERATIONAL_STAGE_SLUGS)

/** True for fulfillment stages that live on the post-close board, not the sales pipeline. */
export function isPostCloseStage(slug: string | null | undefined): boolean {
  return !!slug && POST_CLOSE.has(slug)
}

/** True for operational work-queue columns (count true population, ignore sales status). */
export function isOperationalStage(slug: string | null | undefined): boolean {
  return !!slug && OPERATIONAL.has(slug)
}
