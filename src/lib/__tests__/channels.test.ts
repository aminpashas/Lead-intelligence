import { describe, it, expect } from 'vitest'
import {
  CONVERSATION_CHANNELS,
  CHANNEL_META,
  SOCIAL_CHANNELS,
  SENDABLE_CHANNELS,
  channelMeta,
  channelLabel,
  isConversationChannel,
} from '@/lib/channels'

describe('channel registry', () => {
  it('has metadata for every declared channel, keyed consistently', () => {
    for (const c of CONVERSATION_CHANNELS) {
      expect(CHANNEL_META[c]).toBeDefined()
      // A mismatched `key` would make registry lookups silently return another
      // channel's label/send transport.
      expect(CHANNEL_META[c].key).toBe(c)
    }
  })

  it('covers the channels the DB CHECK constraint allows', () => {
    // Mirrors 20260719120000_social_dm_channels.sql. If the migration widens,
    // this fails until the registry catches up — the exact drift that left
    // messenger/instagram renderable in the DB but invisible in the UI.
    expect([...CONVERSATION_CHANNELS].sort()).toEqual(
      ['email', 'instagram', 'messenger', 'sms', 'voice', 'web_chat', 'whatsapp'].sort()
    )
  })

  it('classifies social DM channels', () => {
    expect([...SOCIAL_CHANNELS].sort()).toEqual(['instagram', 'messenger', 'whatsapp'].sort())
    expect(CHANNEL_META.sms.isSocial).toBe(false)
    expect(CHANNEL_META.email.isSocial).toBe(false)
  })

  it('routes social sends through GHL and never through Twilio/Resend', () => {
    // The bug this guards: a Messenger reply going out over SMS to the lead's
    // phone — a misroute AND a consent violation, since DMing a page is not
    // permission to text.
    expect(CHANNEL_META.messenger.sendVia).toBe('ghl')
    expect(CHANNEL_META.instagram.sendVia).toBe('ghl')
    expect(CHANNEL_META.sms.sendVia).toBe('twilio')
    expect(CHANNEL_META.email.sendVia).toBe('resend')
  })

  it('gives every sendable channel a transport, and every non-sendable none', () => {
    for (const c of CONVERSATION_CHANNELS) {
      const m = CHANNEL_META[c]
      if (m.canSend) expect(m.sendVia).not.toBeNull()
      else expect(m.sendVia).toBeNull()
    }
  })

  it('gives every GHL-routed channel a send type discriminator', () => {
    for (const c of CONVERSATION_CHANNELS) {
      const m = CHANNEL_META[c]
      if (m.sendVia === 'ghl') expect(m.ghlSendType).toBeTruthy()
    }
    expect(CHANNEL_META.messenger.ghlSendType).toBe('FB')
    expect(CHANNEL_META.instagram.ghlSendType).toBe('IG')
  })

  it('marks voice non-sendable — calls are placed from the dialer', () => {
    expect(CHANNEL_META.voice.canSend).toBe(false)
    expect(SENDABLE_CHANNELS).not.toContain('voice')
  })

  it('degrades unknown channel values instead of throwing', () => {
    // Inbox rows come from the DB as plain strings; an unrecognized value must
    // render as a neutral message row, not crash the rail.
    expect(() => channelMeta('tiktok')).not.toThrow()
    expect(channelMeta('tiktok').icon).toBe('message-square')
    expect(channelLabel('tiktok')).toBe('Message')
    expect(channelLabel(null)).toBe('Message')
    expect(channelLabel(undefined)).toBe('Message')
    // …and must NOT masquerade as a real sendable channel.
    expect(channelMeta('tiktok').canSend).toBe(false)
  })

  it('narrows known channel strings', () => {
    expect(isConversationChannel('messenger')).toBe(true)
    expect(isConversationChannel('tiktok')).toBe(false)
    expect(isConversationChannel(null)).toBe(false)
    expect(isConversationChannel(42)).toBe(false)
  })

  it('labels social channels distinctly from SMS', () => {
    expect(channelLabel('messenger')).toBe('Messenger')
    expect(channelLabel('instagram')).toBe('Instagram')
    expect(channelLabel('sms')).toBe('SMS')
  })
})
