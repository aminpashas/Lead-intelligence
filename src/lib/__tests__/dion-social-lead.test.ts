import { describe, it, expect } from 'vitest'
import {
  splitCapturedName,
  buildSocialLeadIngest,
  shouldArmSpeedToLead,
} from '@/lib/bridges/dion-social-lead'
import { dionLeadConsumedSchema, isSelfEmitted } from '@/lib/bridges/dion/lead'
import { safeParseConsumedEvent } from '@/lib/bridges/dion/consumed'

const ORG = '11111111-1111-1111-1111-111111111111'

function captureData(over: Record<string, unknown> = {}) {
  return {
    channel: 'messenger' as const,
    psid: 'PSID_123',
    pageId: 'PAGE_9',
    displayName: 'Barbara J. Haffner',
    firstMessageAt: '2026-07-17T21:37:00.000Z',
    ...over,
  }
}

function envelope(over: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    envelopeVersion: 1,
    source: 'dion-growth-studio',
    occurredAt: '2026-07-17T21:37:00.000Z',
    dionPracticeId: 'practice_1',
    type: 'lead.captured',
    data: captureData(),
    ...over,
  }
}

describe('splitCapturedName', () => {
  it('splits a Meta display name into first + last', () => {
    expect(splitCapturedName(captureData())).toEqual({ firstName: 'Barbara', lastName: 'J. Haffner' })
  })

  it('prefers explicit first/last over the display name', () => {
    const r = splitCapturedName(captureData({ firstName: 'Bee', lastName: 'Haffner' }))
    expect(r).toEqual({ firstName: 'Bee', lastName: 'Haffner' })
  })

  it('handles a single-word display name', () => {
    expect(splitCapturedName(captureData({ displayName: 'Cher' }))).toEqual({
      firstName: 'Cher',
      lastName: null,
    })
  })

  it('returns empty-string firstName when unknown (leads.first_name is NOT NULL)', () => {
    const r = splitCapturedName(captureData({ displayName: null }))
    expect(r.firstName).toBe('')
    expect(r.firstName).not.toBeNull()
  })
})

describe('buildSocialLeadIngest', () => {
  it('dedups on the PSID via a channel-scoped external ref', () => {
    const input = buildSocialLeadIngest(ORG, captureData())
    expect(input.externalRef).toBe('messenger:PSID_123')
  })

  it('leaves email/phone null — Meta gives neither for a DM', () => {
    const input = buildSocialLeadIngest(ORG, captureData())
    expect(input.email).toBeNull()
    expect(input.phoneRaw).toBeNull()
  })

  it('never fabricates sms/email consent (must stay UNKNOWN)', () => {
    const input = buildSocialLeadIngest(ORG, captureData())
    expect(input.consent?.sms).toBeUndefined()
    expect(input.consent?.email).toBeUndefined()
    expect(input.consent?.source).toBe('messenger_inbound')
  })

  it('attributes organic social, not paid', () => {
    expect(buildSocialLeadIngest(ORG, captureData()).utm_source).toBe('facebook')
    expect(buildSocialLeadIngest(ORG, captureData({ channel: 'instagram' })).utm_source).toBe('instagram')
  })

  it('carries the first message into notes for scoring context', () => {
    const input = buildSocialLeadIngest(ORG, captureData({ firstMessageText: '  do you take Delta?  ' }))
    expect(input.notes).toBe('First message: do you take Delta?')
  })

  it('omits notes when there is no message body', () => {
    expect(buildSocialLeadIngest(ORG, captureData({ firstMessageText: '   ' })).notes).toBeNull()
  })
})

describe('shouldArmSpeedToLead', () => {
  it('does not arm a bare DM — a PSID is not an address to send to', () => {
    expect(shouldArmSpeedToLead({ channel: 'messenger', hasVolunteeredContact: false })).toBe(false)
  })

  it('arms when the person volunteered a phone/email in the DM', () => {
    expect(shouldArmSpeedToLead({ channel: 'messenger', hasVolunteeredContact: true })).toBe(true)
  })

  it('applies the same rule on instagram', () => {
    expect(shouldArmSpeedToLead({ channel: 'instagram', hasVolunteeredContact: false })).toBe(false)
    expect(shouldArmSpeedToLead({ channel: 'instagram', hasVolunteeredContact: true })).toBe(true)
  })
})

describe('lead.captured schema', () => {
  it('accepts a well-formed capture', () => {
    expect(dionLeadConsumedSchema.safeParse(envelope()).success).toBe(true)
  })

  it('is reachable through the shared consumed catalog', () => {
    expect(safeParseConsumedEvent(envelope()).success).toBe(true)
  })

  it('still accepts the pre-existing clinical family', () => {
    const clinical = envelope({
      type: 'clinical.scribe_completed',
      source: 'dion-clinical',
      data: { encounterId: 'e1', dionPatientId: 'p1', noteId: 'n1', durationSec: 30 },
    })
    expect(safeParseConsumedEvent(clinical).success).toBe(true)
  })

  it('rejects a capture with no PSID — there would be no dedup key', () => {
    expect(dionLeadConsumedSchema.safeParse(envelope({ data: captureData({ psid: '' }) })).success).toBe(false)
  })

  it('rejects an unknown channel', () => {
    const bad = envelope({ data: captureData({ channel: 'tiktok' }) })
    expect(dionLeadConsumedSchema.safeParse(bad).success).toBe(false)
  })

  it('does NOT consume lead.created — that is LI\'s own emission (echo loop)', () => {
    expect(safeParseConsumedEvent(envelope({ type: 'lead.created' })).success).toBe(false)
  })
})

describe('isSelfEmitted', () => {
  it('flags LI-sourced events so they are never re-ingested', () => {
    expect(isSelfEmitted({ source: 'lead-intelligence' })).toBe(true)
    expect(isSelfEmitted({ source: 'dion-growth-studio' })).toBe(false)
  })
})
