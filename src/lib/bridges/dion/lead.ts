/**
 * VENDORED MIRROR of the Dion spine `@dion/contracts` events/lead.ts — the SUBSET
 * Lead Intelligence CONSUMES. LI is the system of record for the lead CRM, so it
 * normally EMITS `lead.*`. This file is the one inbound direction: a channel owner
 * (Growth Studio for demand-gen social, Patient Engagement / Dion Desk for the
 * conversation surface) captured a raw inbound contact on a channel LI does not
 * own, and hands it to LI to become a real lead.
 *
 * WHY `lead.captured` AND NOT `lead.created`:
 * LI itself emits `lead.created`. If LI also consumed that type, the hub fan-out
 * would deliver LI's own emissions back to LI and mint duplicate leads (an echo
 * loop). A distinct inbound type keeps the two directions disjoint. The receiver
 * additionally refuses any event whose `source` is 'lead-intelligence' as a
 * belt-and-braces guard — see isSelfEmitted() below.
 *
 * SCOPE: capture only. LI does NOT own the Messenger/IG inbox (ECOSYSTEM.md:133,135)
 * — it never replies on these channels. It turns the capture into a scored lead
 * and alerts staff.
 */
import { z } from 'zod'
import { dionEvent } from './envelope'

/** Channels a capture can arrive on. Each is owned by another product; LI only
 * ever reads these. Extend as owners light up more channels. */
export const socialCaptureChannel = z.enum(['messenger', 'instagram'])
export type SocialCaptureChannel = z.infer<typeof socialCaptureChannel>

/**
 * lead.captured — a channel owner received an inbound contact from a NEW person.
 *
 * Contact-info reality: for a Messenger/IG DM, Meta supplies a page-scoped id
 * (PSID) and usually only a display name. Email/phone are absent until the person
 * volunteers them, so both are nullable and `psid` is the stable identity.
 */
export const leadCaptured = dionEvent(
  'lead.captured',
  z.object({
    channel: socialCaptureChannel,
    /** Page-scoped sender id — the ONLY stable identifier Meta guarantees. */
    psid: z.string().min(1),
    /** Meta Page/IG account that received the message. */
    pageId: z.string().min(1),
    displayName: z.string().nullish(),
    firstName: z.string().nullish(),
    lastName: z.string().nullish(),
    email: z.string().nullish(),
    phone: z.string().nullish(),
    /** First inbound message body — context for scoring. May carry PII the
     * person volunteered; it lands in the lead note, not a clinical record. */
    firstMessageText: z.string().nullish(),
    firstMessageAt: z.string(),
    consent: z
      .object({
        channel: socialCaptureChannel,
        /** 'inbound_initiated' = they messaged us first. This is consent to
         * reply ON THAT CHANNEL only — never SMS/email/voice. */
        basis: z.literal('inbound_initiated'),
      })
      .optional(),
  }),
)

export const dionLeadConsumedSchema = z.discriminatedUnion('type', [leadCaptured])

export type DionLeadEvent = z.infer<typeof dionLeadConsumedSchema>
export type LeadCapturedEvent = z.infer<typeof leadCaptured>

/** Echo-loop guard: LI must never ingest an event it emitted itself. */
export function isSelfEmitted(event: { source: string }): boolean {
  return event.source === 'lead-intelligence'
}
