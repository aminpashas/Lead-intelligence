/**
 * Appointment Availability Generator
 *
 * Generates available booking slots based on:
 * - Organization's weekly schedule (which days/hours are open)
 * - Slot duration and buffer time
 * - Existing appointments (blocked)
 * - Blocked dates (holidays, closures)
 * - Minimum notice period
 */

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
  const result: AvailableDay[] = []

  // Calculate minimum booking time (now + min_notice_hours)
  const minBookingTime = new Date(now.getTime() + config.min_notice_hours * 60 * 60 * 1000)

  // Build a map of blocked time ranges from existing appointments
  const blockedRanges = existingAppointments
    .filter((a) => a.status !== 'canceled')
    .map((a) => {
      const start = new Date(a.scheduled_at).getTime()
      const end = start + (a.duration_minutes + config.buffer_minutes) * 60 * 1000
      return { start, end }
    })

  for (let dayOffset = 0; dayOffset < config.advance_days; dayOffset++) {
    const date = new Date(now)
    date.setDate(date.getDate() + dayOffset)
    const dateStr = formatDateLocal(date)
    const dayOfWeek = date.getDay()

    // Skip blocked dates
    if (config.blocked_dates.includes(dateStr)) continue

    // Get schedule for this day of week
    const daySchedule = config.weekly_schedule[String(dayOfWeek)]
    if (!daySchedule) continue // Day not in schedule (closed)

    const times = generateTimeSlotsForDay(
      date,
      daySchedule.start,
      daySchedule.end,
      config.slot_duration_minutes,
      config.buffer_minutes,
      blockedRanges,
      minBookingTime,
      config.max_bookings_per_slot
    )

    if (times.length > 0) {
      result.push({
        date: dateStr,
        dayOfWeek,
        dayLabel: formatDayLabel(date),
        times,
      })
    }
  }

  return result
}

function generateTimeSlotsForDay(
  date: Date,
  startTime: string,
  endTime: string,
  slotDuration: number,
  buffer: number,
  blockedRanges: Array<{ start: number; end: number }>,
  minBookingTime: Date,
  maxPerSlot: number
): string[] {
  const slots: string[] = []
  const [startH, startM] = startTime.split(':').map(Number)
  const [endH, endM] = endTime.split(':').map(Number)

  const dayStart = new Date(date)
  dayStart.setHours(startH, startM, 0, 0)

  const dayEnd = new Date(date)
  dayEnd.setHours(endH, endM, 0, 0)

  const slotMs = slotDuration * 60 * 1000
  const stepMs = (slotDuration + buffer) * 60 * 1000

  let current = dayStart.getTime()

  while (current + slotMs <= dayEnd.getTime()) {
    const slotStart = current
    const slotEnd = current + slotMs

    // Skip if before minimum notice time
    if (new Date(slotStart) < minBookingTime) {
      current += stepMs
      continue
    }

    // Check if slot conflicts with any existing appointment
    const conflicts = blockedRanges.filter(
      (range) => slotStart < range.end && slotEnd > range.start
    )

    if (conflicts.length < maxPerSlot) {
      const slotDate = new Date(slotStart)
      const timeStr = `${String(slotDate.getHours()).padStart(2, '0')}:${String(slotDate.getMinutes()).padStart(2, '0')}`
      slots.push(timeStr)
    }

    current += stepMs
  }

  return slots
}

function formatDateLocal(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function formatDayLabel(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
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
