/**
 * Pure follow-up timing gate for the unified channel.
 *
 * Decides whether a lead is due for a follow-up and which channel to use,
 * from engagement timestamps + consent. `nowMs` is injected so it's testable.
 * The AI *content* of the follow-up comes from `generateTailoredFollowUp()`;
 * this just answers "should we, and how".
 */

export type FollowUpTimingInput = {
  last_contacted_at: string | null
  last_responded_at: string | null
  status: string
  phone: string | null
  email: string | null
  sms_consent: boolean | null
  email_consent: boolean | null
}

export type FollowUpTiming = {
  due: boolean
  daysSinceContact: number | null
  awaitingReply: boolean
  suggestedChannel: 'sms' | 'email' | 'call'
  reason: string
}

const DAY = 24 * 60 * 60 * 1000

/** Pick a consented, reachable channel — SMS first, then email, then a call. */
function pickChannel(lead: FollowUpTimingInput): FollowUpTiming['suggestedChannel'] {
  if (lead.phone && lead.sms_consent) return 'sms'
  if (lead.email && lead.email_consent) return 'email'
  if (lead.phone) return 'call'
  return 'email'
}

export function computeFollowUpTiming(lead: FollowUpTimingInput, nowMs: number): FollowUpTiming {
  const suggestedChannel = pickChannel(lead)

  if (!lead.last_contacted_at) {
    return { due: true, daysSinceContact: null, awaitingReply: false, suggestedChannel, reason: 'Never contacted' }
  }

  const daysSinceContact = Math.floor((nowMs - new Date(lead.last_contacted_at).getTime()) / DAY)
  const awaitingReply =
    !lead.last_responded_at ||
    new Date(lead.last_responded_at).getTime() < new Date(lead.last_contacted_at).getTime()

  if (awaitingReply && daysSinceContact >= 2) {
    return { due: true, daysSinceContact, awaitingReply: true, suggestedChannel, reason: `No reply in ${daysSinceContact} days` }
  }
  if (!awaitingReply && daysSinceContact >= 3) {
    return { due: true, daysSinceContact, awaitingReply: false, suggestedChannel, reason: `${daysSinceContact} days since last touch` }
  }

  return {
    due: false,
    daysSinceContact,
    awaitingReply,
    suggestedChannel,
    reason: awaitingReply ? 'Recently contacted — give them time to reply' : 'Recently engaged',
  }
}
