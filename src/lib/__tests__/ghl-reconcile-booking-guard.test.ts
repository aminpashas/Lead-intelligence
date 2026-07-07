import { describe, it, expect } from 'vitest'
import { hasRealBooking, bookingGuardedSlug, reconciledSlug, type BookingSignal } from '@/lib/ghl/reconcile'

const NOW = new Date('2026-07-07T12:00:00Z')
const base: BookingSignal = { consultation_date: null, hasFutureAppointment: false }

describe('hasRealBooking', () => {
  it('is false with no appointment and no consult date', () => {
    expect(hasRealBooking(base, NOW)).toBe(false)
  })

  it('is true when a future active appointment exists', () => {
    expect(hasRealBooking({ ...base, hasFutureAppointment: true }, NOW)).toBe(true)
  })

  it('is true when consultation_date is in the future', () => {
    expect(hasRealBooking({ ...base, consultation_date: '2026-07-20T17:00:00Z' }, NOW)).toBe(true)
  })

  it('is false when the only consult date is in the past (stale EHR match)', () => {
    expect(hasRealBooking({ ...base, consultation_date: '2024-04-16T17:00:00Z' }, NOW)).toBe(false)
    expect(hasRealBooking({ ...base, consultation_date: '2018-01-02T17:00:00Z' }, NOW)).toBe(false)
  })
})

describe('bookingGuardedSlug', () => {
  it('demotes an unverified GHL "consultation-scheduled" claim to contacted', () => {
    expect(bookingGuardedSlug('consultation-scheduled', false)).toBe('contacted')
  })

  it('keeps consultation-scheduled when a real booking backs it', () => {
    expect(bookingGuardedSlug('consultation-scheduled', true)).toBe('consultation-scheduled')
  })

  it('leaves every other target untouched regardless of booking signal', () => {
    expect(bookingGuardedSlug('consultation-completed', false)).toBe('consultation-completed')
    expect(bookingGuardedSlug('contract-signed', false)).toBe('contract-signed')
    expect(bookingGuardedSlug('lost', false)).toBe('lost')
    expect(bookingGuardedSlug('new', true)).toBe('new')
  })
})

describe('reconciledSlug', () => {
  it('floors an unverified consult claim to contacted for non-terminal leads', () => {
    expect(reconciledSlug('consultation-scheduled', false, 'new')).toBe('contacted')
    expect(reconciledSlug('consultation-scheduled', false, 'consultation_scheduled')).toBe('contacted')
    expect(reconciledSlug('consultation-scheduled', false, null)).toBe('contacted')
  })

  it('routes a terminal-status lead to its own stage instead of reactivating to contacted', () => {
    expect(reconciledSlug('consultation-scheduled', false, 'disqualified')).toBe('lost')
    expect(reconciledSlug('consultation-scheduled', false, 'lost')).toBe('lost')
    expect(reconciledSlug('consultation-scheduled', false, 'consultation_completed')).toBe('consultation-completed')
    expect(reconciledSlug('consultation-scheduled', false, 'completed')).toBe('completed')
  })

  it('keeps a real booking in consultation-scheduled even for a previously-terminal lead (they rebooked)', () => {
    expect(reconciledSlug('consultation-scheduled', true, 'disqualified')).toBe('consultation-scheduled')
    expect(reconciledSlug('consultation-scheduled', true, 'new')).toBe('consultation-scheduled')
  })

  it('never routes a genuine GHL advancement through terminal protection', () => {
    // Non-consult targets pass straight through regardless of LI status.
    expect(reconciledSlug('contract-signed', false, 'disqualified')).toBe('contract-signed')
    expect(reconciledSlug('completed', false, 'disqualified')).toBe('completed')
    expect(reconciledSlug('contacted', false, 'consultation_completed')).toBe('contacted')
  })
})
