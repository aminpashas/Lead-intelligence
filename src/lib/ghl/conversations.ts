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

import { ghlFetch, ghlPost } from './client'
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
  /**
   * File URLs attached to the message. Social DMs routinely arrive with an
   * empty `body` and a single image here — confirmed against live FB payloads.
   */
  attachments?: string[]
  meta?: Record<string, unknown>
}

/** LI-normalized channel for a GHL message, or a routing marker. */
export type NormalizedChannel =
  | 'sms'
  | 'email'
  | 'web_chat'
  | 'whatsapp'
  | 'messenger'
  | 'instagram'
  | 'call'
  | null

/** Call-connection state, derived defensively from GHL's per-revision call fields. */
export type GhlCallState = 'answered' | 'no_answer' | 'voicemail' | 'busy' | 'failed' | 'unknown'

/** Enriched call detail carried on a normalized call record (null fields when GHL omits them). */
export type NormalizedGhlCall = {
  durationSec: number | null
  state: GhlCallState
  recordingUrl: string | null
  /** Raw provider call payload, kept for audit + later re-parse once field names are confirmed. */
  raw: Record<string, unknown> | null
}

/** The persist-ready shape both the webhook and backfill hand to the ingester. */
export type NormalizedGhlMessage = {
  /** Namespaced idempotency key stored in messages.external_id. */
  externalId: string
  channel: NormalizedChannel
  direction: 'inbound' | 'outbound'
  body: string
  subject: string | null
  createdAt: string
  /** Attachment URLs (images on social DMs). Empty when none. */
  attachments: string[]
  /**
   * GHL's raw messageType (e.g. "TYPE_FACEBOOK"). Kept for provenance: the
   * mapped channel is lossy, and when a channel misclassifies this is the only
   * way to tell what GHL actually sent.
   */
  sourceType: string | null
  /** True when this is a call/voicemail record (logged as an activity, not a message). */
  isCall: boolean
  /** Populated only when isCall — duration/outcome/recording pulled from GHL's meta. */
  call?: NormalizedGhlCall
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

/** What GHL echoes back after accepting an outbound message. */
export type GhlSendResult = {
  conversationId?: string
  messageId?: string
}

/**
 * Send an outbound message through GHL.
 *
 * LI relays social replies rather than talking to Meta directly: GHL owns the
 * Facebook/Instagram Page connection, so this needs no Meta app review and the
 * practice keeps one outbound identity. `type` is GHL's channel discriminator
 * (`FB`, `IG`, …) — see the channel registry's `ghlSendType`.
 *
 * Requires the `conversations/message.write` scope on the Private Integration
 * Token; without it GHL answers 401 "not authorized for this scope".
 */
export async function sendGhlMessage(
  config: GhlConfig,
  params: { type: string; contactId: string; message: string; conversationId?: string },
): Promise<GhlSendResult> {
  return ghlPost<GhlSendResult>(conversationsConfig(config), '/conversations/messages', {
    type: params.type,
    contactId: params.contactId,
    message: params.message,
    ...(params.conversationId ? { conversationId: params.conversationId } : {}),
  })
}

// ── Pure normalizers (unit-tested) ───────────────────────────────────────────

/**
 * Map a GHL messageType to an LI channel. Calls/voicemails return 'call' so the
 * caller logs them as an activity (the conversations.channel CHECK constraint
 * has no 'call' value). Genuinely unsupported channels (e.g. GMB) return null.
 *
 * FB/IG were previously dropped here, which is why inbound Messenger/Instagram
 * DMs never reached LI at all — no thread, no lead, no new-lead alert. GHL owns
 * the Meta connection (capture-only); LI mirrors what GHL already received, so
 * this needs no Meta app permissions of its own.
 */
export function mapGhlChannel(messageType: string | undefined): NormalizedChannel {
  const t = (messageType || '').toUpperCase()
  // Order matters: "VOICEMAIL" contains the substring "EMAIL", so calls/voicemails
  // must be classified BEFORE email or every voicemail files as an email thread.
  if (t.includes('CALL') || t.includes('VOICEMAIL')) return 'call'
  if (t.includes('SMS')) return 'sms'
  if (t.includes('EMAIL')) return 'email'
  if (t.includes('WHATSAPP')) return 'whatsapp'
  // Instagram before Facebook: GHL labels IG DMs TYPE_INSTAGRAM, but some
  // revisions prefix them with the parent platform (e.g. "FB_INSTAGRAM"), which
  // would otherwise classify as messenger.
  if (t.includes('INSTAGRAM') || t.includes('_IG')) return 'instagram'
  if (t.includes('FACEBOOK') || t.includes('MESSENGER') || t.includes('_FB')) return 'messenger'
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
 * Derive call detail (duration / connection state / recording) from a GHL call
 * message. GHL's `TYPE_CALL` payload shape drifts across API revisions, so every
 * field is read defensively from several candidate keys and falls back to null —
 * confirm the real keys with scripts/ghl-probe-call-payload.ts and tighten here.
 * Pure + exported so it's unit-testable without a live location.
 */
export function extractGhlCall(msg: GhlMessage): NormalizedGhlCall {
  const meta = (msg.meta ?? {}) as Record<string, unknown>
  const call = ((meta.call as Record<string, unknown>) ?? meta) as Record<string, unknown>
  const num = (v: unknown): number | null => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const durationSec =
    num(call.duration) ?? num(call.callDuration) ?? num(meta.duration) ?? num(meta.callDuration)
  const rawState = String(call.status ?? call.callStatus ?? meta.callStatus ?? msg.status ?? '').toLowerCase()
  const state: GhlCallState =
    /voicemail|vm|voice[-_ ]?mail/.test(rawState) ? 'voicemail'
    : /no[-_ ]?answer|missed|noanswer|unanswered/.test(rawState) ? 'no_answer'
    : /busy/.test(rawState) ? 'busy'
    : /fail|error|canceled|cancelled/.test(rawState) ? 'failed'
    : /answer|complet|connect|in[-_ ]?progress/.test(rawState) ? 'answered'
    : 'unknown'
  const attachments = (msg as { attachments?: unknown }).attachments
  const fromAttachments = Array.isArray(attachments)
    ? (attachments.map(String).find((a) => /\.(mp3|wav|m4a|ogg)(\?|$)/i.test(a)) ?? null)
    : null
  const recordingUrl =
    (typeof call.recordingUrl === 'string' && call.recordingUrl) ||
    (typeof meta.recordingUrl === 'string' && meta.recordingUrl) ||
    fromAttachments ||
    null
  return { durationSec, state, recordingUrl: recordingUrl || null, raw: (msg.meta as Record<string, unknown>) ?? null }
}

/** Attachment URLs off a GHL message, defensively (the key is absent on most). */
function extractAttachments(msg: GhlMessage): string[] {
  const raw = msg.attachments
  if (!Array.isArray(raw)) return []
  return raw.filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
}

/**
 * Convert a raw GHL message into the persist-ready shape, or null when it should
 * be skipped (unsupported channel, or a genuinely empty non-call message). Pure.
 */
export function normalizeGhlMessage(msg: GhlMessage): NormalizedGhlMessage | null {
  if (!msg.id) return null
  const channel = mapGhlChannel(msg.messageType)
  if (channel === null) return null

  const isCall = channel === 'call'
  const body = (msg.body || '').trim()
  const attachments = extractAttachments(msg)
  // A non-call message with neither text nor a file carries no context — skip.
  // An empty body ALONE is not enough: inbound social DMs are frequently just a
  // photo, and treating those as empty silently discarded patient-sent images
  // (verified against a live inbound Facebook message whose only content was a
  // .png). Calls are kept regardless — their metadata is the record.
  if (!isCall && !body && attachments.length === 0) return null

  return {
    externalId: `ghl_msg:${msg.id}`,
    channel,
    direction: mapGhlDirection(msg.direction),
    body,
    subject: msg.subject?.trim() || null,
    attachments,
    sourceType: msg.messageType ?? null,
    createdAt: msg.dateAdded || new Date().toISOString(),
    isCall,
    ...(isCall ? { call: extractGhlCall(msg) } : {}),
  }
}
