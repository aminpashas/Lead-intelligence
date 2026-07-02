import { describe, it, expect } from 'vitest'
import { generateAvailableSlots, type BookingConfig } from '@/lib/booking/availability'
import { zonedTimeToUtc } from '@/lib/booking/timezone'

// These tests use a practice timezone (America/New_York) that differs from the
// CI/dev machine timezone on purpose: it exposes any code that leans on the
// server's local timezone instead of the practice's. All assertions hold
// regardless of the machine timezone.

const BASE: Omit<BookingConfig, 'weekly_schedule'> = {
  slot_duration_minutes: 60,
  buffer_minutes: 0,
  advance_days: 5,
  min_notice_hours: 1,
  blocked_dates: [],
  timezone: 'America/New_York',
  max_bookings_per_slot: 1,
}

describe('generateAvailableSlots (timezone-correct)', () => {
  it('emits slots on the practice-local calendar day', () => {
    // Tuesday 2026-07-07, 9:00–12:00 ET, hourly.
    const config: BookingConfig = { ...BASE, weekly_schedule: { '2': { start: '09:00', end: '12:00' } } }
    const now = new Date('2026-07-07T00:00:00.000Z') // Mon 20:00 ET
    const days = generateAvailableSlots(config, [], now)

    const tue = days.find((d) => d.date === '2026-07-07')
    expect(tue).toBeDefined()
    expect(tue!.times).toEqual(['09:00', '10:00', '11:00'])
  })

  it('blocks the practice-local slot matching an existing appointment given as a UTC instant', () => {
    const config: BookingConfig = { ...BASE, weekly_schedule: { '2': { start: '09:00', end: '12:00' } } }
    const now = new Date('2026-07-07T00:00:00.000Z')

    // 09:00 ET on 2026-07-07 is 13:00 UTC (EDT, UTC-4). Server-local code would
    // mis-locate this instant and fail to remove the 09:00 slot.
    const existing = [
      { scheduled_at: '2026-07-07T13:00:00.000Z', duration_minutes: 60, status: 'scheduled' },
    ]
    const days = generateAvailableSlots(config, existing, now)
    const tue = days.find((d) => d.date === '2026-07-07')!

    expect(tue.times).not.toContain('09:00')
    expect(tue.times).toContain('10:00')
  })

  it('each emitted time round-trips to the UTC instant the practice intends', () => {
    const config: BookingConfig = { ...BASE, weekly_schedule: { '2': { start: '09:00', end: '10:00' } } }
    const now = new Date('2026-07-07T00:00:00.000Z')
    const tue = generateAvailableSlots(config, [], now).find((d) => d.date === '2026-07-07')!

    // The single 09:00 ET slot must correspond to 13:00 UTC.
    expect(tue.times).toEqual(['09:00'])
    expect(zonedTimeToUtc('2026-07-07', tue.times[0], config.timezone).toISOString()).toBe(
      '2026-07-07T13:00:00.000Z',
    )
  })
})
