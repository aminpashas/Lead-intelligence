import { describe, it, expect } from 'vitest'
import { appendEmailFooter } from '@/lib/messaging/email-footer'

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
