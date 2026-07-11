import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  appendEmailFooter,
  generateUnsubscribeToken,
  verifyUnsubscribeToken,
} from '@/lib/messaging/email-footer'

describe('appendEmailFooter', () => {
  const base = { leadId: 'lead-1', orgId: 'org-1', orgName: 'Dion Health SF' }

  it('includes the org name + an unsubscribe link', () => {
    const out = appendEmailFooter('<div>Hi</div>', base)
    expect(out).toContain('Dion Health SF')
    expect(out).toContain('Unsubscribe')
    expect(out).toContain('/api/email/unsubscribe?token=')
  })

  it('renders the physical postal address when provided (CAN-SPAM)', () => {
    const out = appendEmailFooter('<div>Hi</div>', {
      ...base,
      address: '450 Sutter St, San Francisco, CA 94108',
    })
    expect(out).toContain('450 Sutter St, San Francisco, CA 94108')
  })

  it('omits the address line when none is provided (backward compatible)', () => {
    expect(appendEmailFooter('<div>Hi</div>', base)).not.toContain('San Francisco')
    expect(appendEmailFooter('<div>Hi</div>', { ...base, address: null })).not.toContain('San Francisco')
  })
})

describe('verifyUnsubscribeToken (fail-closed)', () => {
  const lead = '11111111-1111-1111-1111-111111111111'
  const org = '22222222-2222-2222-2222-222222222222'
  let prevUnsub: string | undefined
  let prevWebhook: string | undefined

  beforeEach(() => {
    prevUnsub = process.env.UNSUBSCRIBE_SECRET
    prevWebhook = process.env.WEBHOOK_SECRET
    process.env.UNSUBSCRIBE_SECRET = 'test-unsub-secret'
    delete process.env.WEBHOOK_SECRET
  })

  afterEach(() => {
    if (prevUnsub === undefined) delete process.env.UNSUBSCRIBE_SECRET
    else process.env.UNSUBSCRIBE_SECRET = prevUnsub
    if (prevWebhook === undefined) delete process.env.WEBHOOK_SECRET
    else process.env.WEBHOOK_SECRET = prevWebhook
  })

  it('accepts a properly signed token (round-trip)', () => {
    expect(verifyUnsubscribeToken(generateUnsubscribeToken(lead, org))).toBe(true)
  })

  it('rejects a forged unsigned token — the cross-tenant suppression vector', () => {
    // base64(leadId:orgId) with no signature — anyone could construct this.
    const forged = Buffer.from(`${lead}:${org}`).toString('base64')
    expect(forged).not.toContain('.')
    expect(verifyUnsubscribeToken(forged)).toBe(false)
  })

  it('rejects a token with a tampered signature', () => {
    const valid = generateUnsubscribeToken(lead, org)
    const tampered = `${valid.slice(0, valid.indexOf('.'))}.deadbeefdeadbeefdeadbeefdeadbeef`
    expect(verifyUnsubscribeToken(tampered)).toBe(false)
  })

  it('rejects everything when no secret is configured (cannot verify)', () => {
    delete process.env.UNSUBSCRIBE_SECRET
    const forged = Buffer.from(`${lead}:${org}`).toString('base64')
    expect(verifyUnsubscribeToken(forged)).toBe(false)
  })
})
