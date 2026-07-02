/**
 * VENDORED MIRROR of Dion's `events/appointment.ts`. appointment.* is CONSUMED by
 * Dion Clinical (the chairside chart reads the scheduling lifecycle) and PRODUCED
 * by "Patient Engagement" — which, in the Dion suite, is Lead Intelligence.
 *
 * Source of truth: ~/dion-clinical/lib/dion/events/appointment.ts
 */
import { z } from 'zod'
import { dionEvent } from './envelope'

export const appointmentRequested = dionEvent(
  'appointment.requested',
  z.object({
    appointmentId: z.string().min(1),
    dionPatientId: z.string().nullable(),
  }),
)

export const appointmentBooked = dionEvent(
  'appointment.booked',
  z.object({
    appointmentId: z.string().min(1),
    dionPatientId: z.string().nullable(),
    startsAt: z.string().min(1), // ISO 8601; the sender coerces via toISOString()
  }),
)

export const appointmentCancelled = dionEvent(
  'appointment.cancelled',
  z.object({
    appointmentId: z.string().min(1),
    /** Non-PHI coded reason, e.g. "patient-cancel", "no-show", "reschedule". */
    reasonCode: z.string().optional(),
  }),
)

export const dionAppointmentSchema = z.discriminatedUnion('type', [
  appointmentRequested,
  appointmentBooked,
  appointmentCancelled,
])

export type DionAppointmentEvent = z.infer<typeof dionAppointmentSchema>
export type DionAppointmentEventType = DionAppointmentEvent['type']
