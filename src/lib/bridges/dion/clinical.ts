/**
 * VENDORED MIRROR of the Dion spine `@dion/contracts` events/clinical.ts — the
 * SUBSET Lead Intelligence CONSUMES. Dion Clinical is the producer of the
 * clinical.* family; LI is a new subscriber that consumes the two "a visit was
 * summarized" signals to drive sales follow-ups.
 *
 * Keep byte-faithful to ~/dion-clinical/lib/dion/events/clinical.ts (and the hub
 * ~/dion-enterprise-stack/packages/contracts/src/events/clinical.ts).
 *
 * STRICT PHI boundary: these events carry record REFERENCES (encounterId,
 * noteId) + non-PHI counts/durations ONLY — never note bodies or clinical text.
 * LI resolves the actual follow-up brief by calling Dion Clinical's read API.
 */
import { z } from 'zod'
import { dionEvent } from './envelope'

/** clinical.scribe_completed — the ambient scribe produced a summarized note for
 * the encounter. This is our primary "encounter was summarized" trigger. */
export const clinicalScribeCompleted = dionEvent(
  'clinical.scribe_completed',
  z.object({
    encounterId: z.string(),
    dionPatientId: z.string(),
    noteId: z.string(),
    durationSec: z.number().int().nonnegative(),
  }),
)

/** clinical.encounter_completed — the visit closed. Consumed as a fallback
 * summarize trigger for visits that finish without an ambient scribe session. */
export const clinicalEncounterCompleted = dionEvent(
  'clinical.encounter_completed',
  z.object({
    encounterId: z.string(),
    dionPatientId: z.string(),
    providerId: z.string(),
    locationId: z.string(),
    procedureCount: z.number().int().nonnegative(),
    completedAt: z.string(),
  }),
)

export const dionClinicalConsumedSchema = z.discriminatedUnion('type', [
  clinicalScribeCompleted,
  clinicalEncounterCompleted,
])

export type DionClinicalEvent = z.infer<typeof dionClinicalConsumedSchema>
