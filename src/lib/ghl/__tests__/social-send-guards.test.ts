import { describe, it, expect } from 'vitest'
import {
  checkSocialSend,
  classifyGhlSendError,
  type GuardConversation,
  type GuardLead,
} from '@/lib/ghl/social-send-guards'

const convo = (over: Partial<NonNullable<GuardConversation>> = {}) =>
  ({ id: 'c1', channel: 'messenger', lead_id: 'lead-1', ...over }) as NonNullable<GuardConversation>

const lead = (over: Partial<NonNullable<GuardLead>> = {}) =>
  ({ id: 'lead-1', ghl_contact_id: 'ghl-abc', ...over }) as NonNullable<GuardLead>

const ok = {
  conversation: convo(),
  lead: lead(),
  leadId: 'lead-1',
  channel: 'messenger' as const,
  ghlConfigured: true,
}

describe('checkSocialSend', () => {
  it('allows a well-formed Messenger reply', () => {
    expect(checkSocialSend(ok)).toBeNull()
  })

  it('allows a well-formed Instagram reply', () => {
    expect(
      checkSocialSend({
        ...ok,
        conversation: convo({ channel: 'instagram' }),
        channel: 'instagram',
      })
    ).toBeNull()
  })

  it('refuses when the thread does not exist — reply-only by construction', () => {
    // No existing thread means no inbound DM, which means no implied consent
    // and no Meta-permitted reply window. LI must not originate a cold DM.
    const r = checkSocialSend({ ...ok, conversation: null })
    expect(r?.reason).toBe('conversation_not_found')
    expect(r?.status).toBe(404)
  })

  it('refuses when the thread belongs to a different lead', () => {
    const r = checkSocialSend({ ...ok, conversation: convo({ lead_id: 'someone-else' }) })
    expect(r?.reason).toBe('conversation_lead_mismatch')
    expect(r?.status).toBe(400)
  })

  it('refuses a channel mismatch — the wrong-transport bug', () => {
    // Routing a "messenger" send into an SMS thread would text a patient who
    // only ever DM'd the page.
    const r = checkSocialSend({ ...ok, conversation: convo({ channel: 'sms' }) })
    expect(r?.reason).toBe('channel_mismatch')
    expect(r?.error).toMatch(/sms thread, not messenger/i)
    expect(r?.status).toBe(400)
  })

  it('refuses when messenger and instagram are crossed', () => {
    const r = checkSocialSend({
      ...ok,
      conversation: convo({ channel: 'instagram' }),
      channel: 'messenger',
    })
    expect(r?.reason).toBe('channel_mismatch')
  })

  it('refuses when the lead has no GHL contact id', () => {
    // Meta gives no phone/email for a DM-only lead, so this is the only address.
    const r = checkSocialSend({ ...ok, lead: lead({ ghl_contact_id: null }) })
    expect(r?.reason).toBe('no_ghl_contact')
    expect(r?.status).toBe(409)
  })

  it('refuses when the lead is missing', () => {
    const r = checkSocialSend({ ...ok, lead: null })
    expect(r?.reason).toBe('lead_not_found')
  })

  it('refuses when GHL is not connected for the org', () => {
    const r = checkSocialSend({ ...ok, ghlConfigured: false })
    expect(r?.reason).toBe('ghl_not_configured')
    expect(r?.status).toBe(409)
  })

  it('checks the thread before the lead, so a mismatch is not masked', () => {
    // Both are wrong; the channel mismatch is the more dangerous one and must
    // surface rather than being hidden behind a generic lead error.
    const r = checkSocialSend({
      ...ok,
      conversation: convo({ channel: 'sms' }),
      lead: lead({ ghl_contact_id: null }),
    })
    expect(r?.reason).toBe('channel_mismatch')
  })
})

describe('classifyGhlSendError', () => {
  it('names the missing PIT scope instead of a generic 500', () => {
    const r = classifyGhlSendError('GHL 401 /conversations/messages: token not authorized for this scope')
    expect(r.reason).toBe('ghl_scope_missing')
    expect(r.status).toBe(502)
    expect(r.error).toMatch(/conversations\/message\.write/)
  })

  it('matches the scope failure on wording alone', () => {
    expect(classifyGhlSendError('not authorized for this scope').reason).toBe('ghl_scope_missing')
  })

  it('passes other failures through as a 500', () => {
    const r = classifyGhlSendError('GHL 500 /conversations/messages: upstream exploded')
    expect(r.reason).toBe('ghl_send_failed')
    expect(r.status).toBe(500)
    expect(r.error).toMatch(/upstream exploded/)
  })
})
