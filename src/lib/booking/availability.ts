/**
 * Appointment Availability Generator
 *
 * Generates available booking slots based on:
 * - Organization's weekly schedule (which days/hours are open)
 * - Slot duration and buffer time
 * - Existing appointments (blocked)
 * - Blocked dates (holidays, closures)
 * - Minimum notice period
 *
 * All wall-clock reasoning (which day, which hour is open) happens in the
 * PRACTICE timezone via `config.timezone`, while conflict/notice checks use
 * absolute UTC instants. This is independent of the server timezone (UTC on
 * Vercel) — see src/lib/booking/timezone.ts.
 */

import { zonedTimeToUtc, getZonedParts } from './timezone'

export type WeeklySchedule = Record<string, { start: string; end: string }>

export type BookingConfig = {
  weekly_schedule: WeeklySchedule
  slot_duration_minutes: number
  buffer_minutes: number
  advance_days: number
  min_notice_hours: number
  blocked_dates: string[]
  timezone: string
  max_bookings_per_slot: number
}

export type ExistingAppointment = {
  scheduled_at: string
  duration_minutes: number
  status: string
}

export type AvailableDay = {
  date: string // YYYY-MM-DD
  dayOfWeek: number // 0=Sun, 6=Sat
  dayLabel: string // "Monday, April 15"
  times: string[] // ["09:00", "10:15", "11:30", ...]
}

/**
 * Generate available booking slots for the next N days.
 */
export function generateAvailableSlots(
  config: BookingConfig,
  existingAppointments: ExistingAppointment[],
  startDate?: Date
): AvailableDay[] {
  const now = startDate || new Date()
  const tz = config.timezone
  const result: AvailableDay[] = []

  // Minimum booking time as an absolute instant (now + min_notice_hours).
  const minBookingTimeMs = now.getTime() + config.min_notice_hours * 60 * 60 * 1000

  // Blocked ranges are absolute UTC instants — timezone-independent.
  const blockedRanges = existingAppointments
    .filter((a) => a.status !== 'canceled')
    .map((a) => {
      const start = new Date(a.scheduled_at).getTime()
      const end = start + (a.duration_minutes + config.buffer_minutes) * 60 * 1000
      return { start, end }
    })

  // Walk calendar days in the PRACTICE timezone. Anchoring at noon UTC of each
  // offset keeps the derived local date stable (no midnight/DST drift for the
  // US timezones this serves).
  const today = getZonedParts(now, tz)
  for (let dayOffset = 0; dayOffset < config.advance_days; dayOffset++) {
    const anchor = new Date(Date.UTC(today.year, today.month - 1, today.day + dayOffset, 12, 0, 0))
    const parts = getZonedParts(anchor, tz)
    const dateStr = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
    const dayOfWeek = parts.weekday

    // Skip blocked dates
    if (config.blocked_dates.includes(dateStr)) continue

    // Get schedule for this day of week
    const daySchedule = config.weekly_schedule[String(dayOfWeek)]
    if (!daySchedule) continue // Day not in schedule (closed)

    const times = generateTimeSlotsForDay(
      dateStr,
      tz,
      daySchedule.start,
      daySchedule.end,
      config.slot_duration_minutes,
      config.buffer_minutes,
      blockedRanges,
      minBookingTimeMs,
      config.max_bookings_per_slot
    )

    if (times.length > 0) {
      result.push({
        date: dateStr,
        dayOfWeek,
        dayLabel: formatDayLabel(dateStr, tz),
        times,
      })
    }
  }

  return result
}

function generateTimeSlotsForDay(
  dateStr: string,
  tz: string,
  startTime: string,
  endTime: string,
  slotDuration: number,
  buffer: number,
  blockedRanges: Array<{ start: number; end: number }>,
  minBookingTimeMs: number,
  maxPerSlot: number
): string[] {
  const slots: string[] = []
  const [startH, startM] = startTime.split(':').map(Number)
  const [endH, endM] = endTime.split(':').map(Number)

  const startMinutes = startH * 60 + startM
  const endMinutes = endH * 60 + endM
  const stepMinutes = slotDuration + buffer
  const slotMs = slotDuration * 60 * 1000

  // Iterate wall-clock minutes in the practice day; resolve each to a real UTC
  // instant so notice/conflict checks are exact.
  for (let mins = startMinutes; mins + slotDuration <= endMinutes; mins += stepMinutes) {
    const timeStr = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
    const slotStart = zonedTimeToUtc(dateStr, timeStr, tz).getTime()
    const slotEnd = slotStart + slotMs

    // Skip if before minimum notice time
    if (slotStart < minBookingTimeMs) continue

    // Check if slot conflicts with any existing appointment
    const conflicts = blockedRanges.filter(
      (range) => slotStart < range.end && slotEnd > range.start
    )

    if (conflicts.length < maxPerSlot) {
      slots.push(timeStr)
    }
  }

  return slots
}

function formatDayLabel(dateStr: string, tz: string): string {
  // Noon-UTC anchor renders the intended calendar day in the practice tz.
  const [y, m, d] = dateStr.split('-').map(Number)
  const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
  return anchor.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: tz,
  })
}

/**
 * Format a time string (HH:MM) for display.
 */
export function formatTimeDisplay(time: string): string {
  const [h, m] = time.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const hour = h === 0 ? 12 : h > 12 ? h - 12 : h
  return `${hour}:${String(m).padStart(2, '0')} ${ampm}`
}
