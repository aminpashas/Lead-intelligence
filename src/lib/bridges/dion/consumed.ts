/**
 * The subset of the Dion event catalog that Lead Intelligence CONSUMES at its
 * inbound bus receiver (/api/bus/receive) — the inbound mirror of the families
 * LI emits from src/lib/bridges/dion-clinical.ts.
 *
 * LI consumes:
 *   - clinical.* — "a visit was summarized" signals from Dion Clinical.
 *   - lead.captured — an inbound contact captured by a channel owner (social DMs)
 *     handed to LI to become a real lead. See ./lead.ts for why the inbound type
 *     is `lead.captured` and not `lead.created` (echo-loop avoidance).
 *
 * The receiver validates every inbound POST against this union before recording
 * it, so an event outside the catalog is rejected with 400 (the hub's forwarder
 * then dead-letters / marks it `unconsumed`) rather than silently accepted. Add a
 * family here when LI starts consuming it.
 */
import { dionClinicalConsumedSchema, type DionClinicalEvent } from './clinical'
import { dionLeadConsumedSchema, type DionLeadEvent } from './lead'

export const dionConsumedSchema = dionClinicalConsumedSchema.or(dionLeadConsumedSchema)

export type DionConsumedEvent = DionClinicalEvent | DionLeadEvent
export type DionConsumedEventType = DionConsumedEvent['type']

/** Non-throwing parse — the receiver 400s a bad/out-of-catalog inbound event. */
export function safeParseConsumedEvent(input: unknown) {
  return dionConsumedSchema.safeParse(input)
}
