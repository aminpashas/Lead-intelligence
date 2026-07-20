/**
 * Conversation channel registry — the single source of truth for every channel
 * LI can hold a thread on.
 *
 * Before this existed the same channel list was re-declared in at least four
 * places (the DB CHECK constraint, `ConversationChannel`, the inbox filter, and
 * the thread composer) and they drifted: the migration allowed `messenger` /
 * `instagram`, ingest wrote them, but the type union and the inbox filter had
 * never heard of them — so real patient DMs landed in the database and were
 * invisible in the UI. Adding a channel is now one entry here.
 *
 * Pure data on purpose (no JSX) so server components, API routes, and the
 * ingest path can import it without pulling in the icon library; `icon` names a
 * glyph that `<ChannelIcon>` resolves.
 */

/** Every channel a conversation/message row may carry. Mirrors the DB CHECK. */
export const CONVERSATION_CHANNELS = [
  'sms',
  'email',
  'voice',
  'messenger',
  'instagram',
  'whatsapp',
  'web_chat',
] as const

export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number]

/** Transport that carries an outbound reply on a channel. */
export type SendTransport = 'twilio' | 'resend' | 'ghl' | null

export type ChannelMeta = {
  key: ConversationChannel
  /** Full label — thread headers, filter drawer. */
  label: string
  /** Compact label for the segmented filter control. */
  short: string
  /**
   * Glyph name resolved by `<ChannelIcon>`. Deliberately generic shapes rather
   * than brand marks — lucide 1.x removed its Facebook/Instagram icons, and the
   * brand `accent` colour already carries the recognition.
   */
  icon: 'message-square' | 'mail' | 'phone' | 'message-circle' | 'camera' | 'message-circle-more' | 'globe'
  /** Tailwind text color for the channel glyph/label. */
  accent: string
  /** A social DM channel — implied consent covers replying in-channel only. */
  isSocial: boolean
  /** Can staff send a reply on this channel from LI today? */
  canSend: boolean
  /** Which transport carries that reply. */
  sendVia: SendTransport
  /**
   * GHL's `type` discriminator on POST /conversations/messages. Only set for
   * channels LI relays through GHL (it owns the Meta connection).
   */
  ghlSendType: string | null
}

export const CHANNEL_META: Record<ConversationChannel, ChannelMeta> = {
  sms: {
    key: 'sms',
    label: 'SMS',
    short: 'SMS',
    icon: 'message-square',
    accent: 'text-aurea-ink-2',
    isSocial: false,
    canSend: true,
    sendVia: 'twilio',
    ghlSendType: 'SMS',
  },
  email: {
    key: 'email',
    label: 'Email',
    short: 'Email',
    icon: 'mail',
    accent: 'text-aurea-ink-2',
    isSocial: false,
    canSend: true,
    sendVia: 'resend',
    ghlSendType: 'Email',
  },
  voice: {
    key: 'voice',
    label: 'Voice',
    short: 'Voice',
    icon: 'phone',
    accent: 'text-aurea-ink-2',
    isSocial: false,
    // Voice threads are call transcripts/logs; you place a call from the
    // dialer, you don't type a reply into the thread.
    canSend: false,
    sendVia: null,
    ghlSendType: null,
  },
  messenger: {
    key: 'messenger',
    label: 'Messenger',
    short: 'FB',
    icon: 'message-circle',
    accent: 'text-[#0866FF]',
    isSocial: true,
    canSend: true,
    sendVia: 'ghl',
    ghlSendType: 'FB',
  },
  instagram: {
    key: 'instagram',
    label: 'Instagram',
    short: 'IG',
    icon: 'camera',
    accent: 'text-[#C13584]',
    isSocial: true,
    canSend: true,
    sendVia: 'ghl',
    ghlSendType: 'IG',
  },
  whatsapp: {
    key: 'whatsapp',
    label: 'WhatsApp',
    short: 'WA',
    icon: 'message-circle-more',
    accent: 'text-[#25D366]',
    isSocial: true,
    // Mapped by ingest, but a channel audit of 6,000 live conversations found
    // zero WhatsApp threads — no send path has ever been exercised, so it stays
    // read-only until one actually exists to test against.
    canSend: false,
    sendVia: null,
    ghlSendType: 'WhatsApp',
  },
  web_chat: {
    key: 'web_chat',
    label: 'Web chat',
    short: 'Web',
    icon: 'globe',
    accent: 'text-aurea-ink-2',
    isSocial: false,
    canSend: false,
    sendVia: null,
    ghlSendType: 'Live_Chat',
  },
}

/** Unknown channel values render as a neutral message thread rather than blank. */
const FALLBACK: ChannelMeta = {
  key: 'sms',
  label: 'Message',
  short: 'Msg',
  icon: 'message-square',
  accent: 'text-aurea-ink-3',
  isSocial: false,
  canSend: false,
  sendVia: null,
  ghlSendType: null,
}

export function isConversationChannel(v: unknown): v is ConversationChannel {
  return typeof v === 'string' && (CONVERSATION_CHANNELS as readonly string[]).includes(v)
}

/**
 * Metadata for a channel string of unknown provenance (a DB value, a GHL
 * payload). Never throws — an unrecognized channel degrades to a neutral
 * message row instead of crashing the inbox.
 */
export function channelMeta(channel: string | null | undefined): ChannelMeta {
  return isConversationChannel(channel) ? CHANNEL_META[channel] : FALLBACK
}

/** Human label for a channel string. */
export function channelLabel(channel: string | null | undefined): string {
  return channelMeta(channel).label
}

/** Channels staff can currently reply on, for composer/UI gating. */
export const SENDABLE_CHANNELS = CONVERSATION_CHANNELS.filter((c) => CHANNEL_META[c].canSend)

/** Social DM channels (implied in-channel consent only — never SMS/email/voice). */
export const SOCIAL_CHANNELS = CONVERSATION_CHANNELS.filter((c) => CHANNEL_META[c].isSocial)
