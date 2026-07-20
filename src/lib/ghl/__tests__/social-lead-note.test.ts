import { describe, it, expect } from 'vitest'
import { firstInboundNote } from '@/lib/ghl/social-lead'
import type { NormalizedGhlMessage } from '@/lib/ghl/conversations'

const msg = (over: Partial<NormalizedGhlMessage>): NormalizedGhlMessage => ({
  externalId: 'ghl:1',
  channel: 'messenger',
  direction: 'inbound',
  body: 'hi',
  subject: null,
  createdAt: '2026-07-20T00:00:00Z',
  attachments: [],
  sourceType: 'TYPE_FACEBOOK',
  isCall: false,
  ...over,
})

describe('firstInboundNote', () => {
  it('quotes an inbound message', () => {
    expect(firstInboundNote('Messenger', msg({ body: 'do you take insurance?' }))).toBe(
      'First Messenger message: do you take insurance?',
    )
  })

  it('returns null for an OUTBOUND message', () => {
    // Regression: the poller accepts both directions, so on a thread the
    // practice spoke in first this used to record our own canned reply
    // ("Hi we're in 450 sutter st…") as the lead's opening message — and the
    // staff alert quoted it back as if the patient had written it.
    expect(
      firstInboundNote(
        'Messenger',
        msg({ direction: 'outbound', body: "Hi we're in 450 sutter st San Francisco" }),
      ),
    ).toBeNull()
  })

  it('returns null for an empty body', () => {
    expect(firstInboundNote('Messenger', msg({ body: '' }))).toBeNull()
  })

  it('uses the channel label it is given', () => {
    expect(firstInboundNote('Instagram DM', msg({ channel: 'instagram', body: 'hey' }))).toBe(
      'First Instagram DM message: hey',
    )
  })
})
