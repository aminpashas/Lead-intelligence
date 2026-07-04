import { describe, it, expect } from 'vitest'
import { hasLiEngagement, type LeadEngagement } from '@/lib/ghl/reconcile'

const base: LeadEngagement = {
  status: 'new',
  total_messages_sent: 0,
  total_messages_received: 0,
  last_contacted_at: null,
  last_responded_at: null,
}

describe('hasLiEngagement', () => {
  it('is false for a pristine, never-worked lead', () => {
    expect(hasLiEngagement(base)).toBe(false)
    expect(hasLiEngagement({ ...base, status: null })).toBe(false)
  })

  it('is true when the LI status has moved past intake', () => {
    expect(hasLiEngagement({ ...base, status: 'contacted' })).toBe(true)
    expect(hasLiEngagement({ ...base, status: 'consultation_completed' })).toBe(true)
  })

  it('is true when any message was sent or received', () => {
    expect(hasLiEngagement({ ...base, total_messages_sent: 1 })).toBe(true)
    expect(hasLiEngagement({ ...base, total_messages_received: 3 })).toBe(true)
  })

  it('is true when a contact/response timestamp exists even at status "new"', () => {
    expect(hasLiEngagement({ ...base, last_contacted_at: '2026-07-03T22:06:24Z' })).toBe(true)
    expect(hasLiEngagement({ ...base, last_responded_at: '2026-07-03T22:06:36Z' })).toBe(true)
  })
})
