/**
 * GoHighLevel (LeadConnector) Conversations API — read side + pure normalizers.
 *
 * The stage sync (client.ts) only reads opportunities/contacts. This module adds
 * the conversation layer: the two-way SMS/email history that lives in GHL and
 * that LI's AI needs for context. Shared by:
 *
 *   • the go-forward webhook   (src/app/api/webhooks/ghl/message)
 *   • the historical backfill  (src/lib/ghl/backfill-conversations.ts)
 *
 * Everything below the API calls is a pure function so it can be unit-tested
 * without a live GHL location (see src/lib/__tests__/ghl-conversations.test.ts).
 */

import { ghlFetch } from './client'
import type { GhlConfig } from './types'

/** GHL Conversations API is versioned separately from the opportunities API. */
const CONVERSATIONS_VERSION = '2021-04-15'

/** A GHL conversation envelope (one per contact+channel thread). */
export type GhlConversation = {
  id: string
  contactId?: string
  locationId?: string
  type?: string
  lastMessageType?: string
  /** epoch ms or ISO, depending on API revision — read defensively. */
  lastMessageDate?: number | string
}

/** A single message inside a GHL conversation. */
export type GhlMessage = {
  id: string
  /** e.g. "TYPE_SMS", "TYPE_EMAIL", "TYPE_CALL", "TYPE_VOICEMAIL". */
  messageType?: string
  /** Numeric type on some revisions; we prefer messageType. */
  type?: number | string
  body?: string
  direction?: string
  status?: string
  dateAdded?: string
  contactId?: string
  conversationId?: string
  /** Email threads carry the subject + html here on some revisions. */
  subject?: string
  meta?: Record<string, unknown>
}

/** LI-normalized channel for a GHL message, or a routing marker. */
export type NormalizedChannel = 'sms' | 'email' | 'web_chat' | 'whatsapp' | 'call' | null

/** The persist-ready shape both the webhook and backfill hand to the ingester. */
export type NormalizedGhlMessage = {
  /** Namespaced idempotency key stored in messages.external_id. */
  externalId: string
  channel: NormalizedChannel
  direction: 'inbound' | 'outbound'
  body: string
  subject: string | null
  createdAt: string
  /** True when this is a call/voicemail record (logged as an activity, not a message). */
  isCall: boolean
}

/** GHL conversations need their own Version header; opportunities use another. */
function conversationsConfig(config: GhlConfig): GhlConfig {
  return { ...config, version: CONVERSATIONS_VERSION }
}

/** One page of conversations for a location, with the cursor for the next page. */
export type ConversationPage = {
  conversations: GhlConversation[]
  /** Cursor (last conversation's lastMessageDate) for the next page; undefined when done. */
  nextStartAfterDate?: string
}

/**
 * Search a location's conversations. GHL pages this endpoint by
 * `startAfterDate` (the sort timestamp of the last row seen). Passing a
 * `contactId` narrows to one person's threads. Returns the cursor for the next
 * page; the caller stops when a short page comes back.
 */
export async function searchConversations(
  config: GhlConfig,
  params: { contactId?: string; startAfterDate?: string; limit?: number; sort?: 'asc' | 'desc' } = {},
): Promise<ConversationPage> {
  const limit = params.limit ?? 100
  // `startAfterDate` is a bidirectional cursor: with sort=asc it returns
  // conversations NEWER than the date, with sort=desc it returns OLDER ones
  // (verified against the live API). So the same last-item-date cursor pages
  // forward (asc = full sweep, oldest-first) or backward (desc = recent-first).
  const data = await ghlFetch<{ conversations?: GhlConversation[] }>(
    conversationsConfig(config),
    '/conversations/search',
    {
      locationId: config.locationId,
      contactId: params.contactId,
      limit,
      startAfterDate: params.startAfterDate,
      sortBy: 'last_message_date',
      sort: params.sort ?? 'asc',
    },
  )
  const conversations = data.conversations ?? []
  const full = conversations.length >= limit
  const last = conversations[conversations.length - 1]
  const cursor = full && last?.lastMessageDate != null ? String(last.lastMessageDate) : undefined
  return { conversations, nextStartAfterDate: cursor }
}

/** One page of messages within a conversation. */
export type MessagePage = {
  messages: GhlMessage[]
  /** Cursor for older messages; undefined when the thread is exhausted. */
  nextLastMessageId?: string
}

/**
 * Fetch one page of a conversation's messages. GHL returns newest-first and
 * pages backward via `lastMessageId`; `nextPage` signals more remain.
 */
export async function getConversationMessages(
  config: GhlConfig,
  conversationId: string,
  params: { lastMessageId?: string; limit?: number } = {},
): Promise<MessagePage> {
  const data = await ghlFetch<{
    messages?: { messages?: GhlMessage[]; lastMessageId?: string; nextPage?: boolean }
  }>(conversationsConfig(config), `/conversations/${encodeURIComponent(conversationId)}/messages`, {
    limit: params.limit ?? 100,
    lastMessageId: params.lastMessageId,
  })
  const inner = data.messages ?? {}
  const messages = inner.messages ?? []
  return {
    messages,
    nextLastMessageId: inner.nextPage && inner.lastMessageId ? inner.lastMessageId : undefined,
  }
}

// ── Pure normalizers (unit-tested) ───────────────────────────────────────────

/**
 * Map a GHL messageType to an LI channel. Calls/voicemails return 'call' so the
 * caller logs them as an activity (the conversations.channel CHECK constraint
 * has no 'call' value). Unsupported channels (FB/IG/GMB) return null → skipped.
 */
export function mapGhlChannel(messageType: string | undefined): NormalizedChannel {
  const t = (messageType || '').toUpperCase()
  // Order matters: "VOICEMAIL" contains the substring "EMAIL", so calls/voicemails
  // must be classified BEFORE email or every voicemail files as an email thread.
  if (t.includes('CALL') || t.includes('VOICEMAIL')) return 'call'
  if (t.includes('SMS')) return 'sms'
  if (t.includes('EMAIL')) return 'email'
  if (t.includes('WHATSAPP')) return 'whatsapp'
  if (t.includes('LIVE_CHAT') || t.includes('WEBCHAT') || t.includes('WEB_CHAT') || t.includes('CHAT'))
    return 'web_chat'
  return null
}

/** Normalize GHL's direction into LI's two-value enum. Defaults to inbound. */
export function mapGhlDirection(direction: string | undefined): 'inbound' | 'outbound' {
  return (direction || '').toLowerCase() === 'outbound' ? 'outbound' : 'inbound'
}

/**
 * TCPA opt-out detection — matches the live Twilio webhook's keyword set. Only
 * meaningful for inbound SMS; the caller gates on channel+direction.
 */
export function isOptOutMessage(body: string | undefined): boolean {
  return /^\s*(stop|stopall|unsubscribe|cancel|end|quit|optout|opt-out)\s*$/i.test(body || '')
}

/** Opt-back-in keywords (mirror of the Twilio path). */
export function isOptInMessage(body: string | undefined): boolean {
  return /^\s*(start|unstop|subscribe)\s*$/i.test(body || '')
}

/**
 * Convert a raw GHL message into the persist-ready shape, or null when it should
 * be skipped (unsupported channel, or empty non-call body). Pure.
 */
export function normalizeGhlMessage(msg: GhlMessage): NormalizedGhlMessage | null {
  if (!msg.id) return null
  const channel = mapGhlChannel(msg.messageType)
  if (channel === null) return null

  const isCall = channel === 'call'
  const body = (msg.body || '').trim()
  // Non-call messages with no body carry no context — skip. Calls are kept even
  // without a body (the metadata itself is the record).
  if (!isCall && !body) return null

  return {
    externalId: `ghl_msg:${msg.id}`,
    channel,
    direction: mapGhlDirection(msg.direction),
    body,
    subject: msg.subject?.trim() || null,
    createdAt: msg.dateAdded || new Date().toISOString(),
    isCall,
  }
}
