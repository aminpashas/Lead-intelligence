/**
 * Pure preflight guards for sending a social DM reply through GHL.
 *
 * Extracted from /api/social/send so the refusal rules are unit-testable
 * without a live Supabase or GHL. Everything here is a pure function over
 * already-fetched rows — the route stays thin and does only I/O.
 */
import { CHANNEL_META, type ConversationChannel } from '@/lib/channels'

export type SendRefusal = {
  error: string
  reason: string
  status: number
}

/** Minimal shapes the guards need — deliberately narrower than the DB rows. */
export type GuardConversation = { id: string; channel: string; lead_id: string } | null
export type GuardLead = { id: string; ghl_contact_id: string | null } | null

/**
 * Decide whether this reply may be sent, or why not.
 *
 * Returns null when the send is allowed. The checks exist because a social
 * reply is irreversible and leaves our boundary for Meta — a mismatch here
 * means a message reaching the wrong person on the wrong channel.
 */
export function checkSocialSend(params: {
  conversation: GuardConversation
  lead: GuardLead
  leadId: string
  channel: ConversationChannel
  ghlConfigured: boolean
}): SendRefusal | null {
  const { conversation, lead, leadId, channel, ghlConfigured } = params

  if (!conversation) {
    return { error: 'Conversation not found', reason: 'conversation_not_found', status: 404 }
  }
  // Reply-only by construction: without an existing thread there is no implied
  // consent and no Meta-permitted window, so there is nothing to reply into.
  if (conversation.lead_id !== leadId) {
    return {
      error: 'Conversation does not belong to this lead',
      reason: 'conversation_lead_mismatch',
      status: 400,
    }
  }
  // Guards the nastiest failure: routing a "Messenger" reply into an SMS thread
  // would send it out over the wrong transport entirely.
  if (conversation.channel !== channel) {
    return {
      error: `Conversation is a ${conversation.channel} thread, not ${channel}`,
      reason: 'channel_mismatch',
      status: 400,
    }
  }
  if (!lead) {
    return { error: 'Lead not found', reason: 'lead_not_found', status: 404 }
  }
  // Meta gives no phone or email for a DM-only lead, so the GHL contact id is
  // the only address that can route a reply back.
  if (!lead.ghl_contact_id) {
    return {
      error: 'Lead is not linked to a GHL contact',
      reason: 'no_ghl_contact',
      status: 409,
    }
  }
  if (!ghlConfigured) {
    return {
      error: 'GHL is not connected for this organization',
      reason: 'ghl_not_configured',
      status: 409,
    }
  }
  if (!CHANNEL_META[channel].ghlSendType) {
    return { error: `No send path for ${channel}`, reason: 'no_send_path', status: 400 }
  }
  return null
}

/**
 * Turn a thrown GHL error into a response shape.
 *
 * A missing `conversations/message.write` scope on the Private Integration
 * Token is by far the likeliest failure and is a CONFIG problem, not a bug —
 * naming it explicitly stops it being triaged as a generic 500.
 */
export function classifyGhlSendError(raw: string): SendRefusal {
  const scopeIssue = /401|not authorized for this scope/i.test(raw)
  if (scopeIssue) {
    return {
      error:
        'GHL rejected the send — the integration token is missing the conversations/message.write scope.',
      reason: 'ghl_scope_missing',
      status: 502,
    }
  }
  return { error: raw, reason: 'ghl_send_failed', status: 500 }
}
