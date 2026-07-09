/**
 * Dion Desk event family (vendored @dion/contracts mirror — see envelope.ts).
 *
 * comms.contact_identified — an inbound contact to a tracked number was
 * identified as an existing patient. Dion Desk owns the front-desk / support
 * interaction for existing patients (ecosystem matrix); this event lets it open
 * the interaction. IDs / references / codes ONLY — never PHI content.
 */
import { z } from 'zod'
import { dionEvent } from './envelope'

export const dionDeskContactSchema = dionEvent(
  'comms.contact_identified',
  z.object({
    organizationId: z.string().min(1),
    /** LI leads.id parked off-funnel for this contact. */
    leadId: z.string().min(1),
    /** LI patients.id (CareStack mirror row) this contact matched. */
    liPatientId: z.string().min(1).nullable(),
    /** Which deterministic hash matched (audit / confidence). */
    matchMethod: z.enum(['email_hash', 'phone_hash']),
    /** Origin channel — always an inbound call for this event. */
    channel: z.literal('inbound_call'),
    /** Raw source label (e.g. 'whatconverts'). */
    sourceType: z.string().nullable(),
  }),
)

export type DionDeskContactEvent = z.infer<typeof dionDeskContactSchema>
