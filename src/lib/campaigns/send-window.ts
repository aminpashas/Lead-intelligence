import { getLocalHourAndDay } from '@/lib/autopilot/config'

/**
 * Check if the current time is within a campaign's allowed send window.
 * Returns { allowed: true } or { allowed: false, nextValidTime: Date }.
 *
 * The current wall-clock hour/day are derived in the campaign's timezone via
 * Intl.DateTimeFormat (getLocalHourAndDay) — DST-correct. The previous code did
 * `new Date(now.toLocaleString('en-US', {timeZone: tz}))`, which re-parses a
 * localized string in the SERVER's timezone (implementation-defined, drifts
 * across DST), so sends could fire at the wrong local hour.
 *
 * `now` is injectable for deterministic DST-boundary testing.
 */
export function checkSendWindow(
  sendWindow: {
    start_hour?: number  // 0-23, default 9
    end_hour?: number    // 0-23, default 20
    timezone?: string    // IANA timezone, default 'America/New_York'
    days?: number[]      // 0=Sun, 1=Mon...6=Sat. Default [1,2,3,4,5] (weekdays)
  } | null,
  now: Date = new Date()
): { allowed: boolean; nextValidTime?: Date } {
  if (!sendWindow) return { allowed: true } // No window = always allowed

  const tz = sendWindow.timezone || 'America/New_York'
  const startHour = sendWindow.start_hour ?? 9
  const endHour = sendWindow.end_hour ?? 20
  const allowedDays = sendWindow.days ?? [1, 2, 3, 4, 5]

  const { hour: currentHour, day: currentDay } = getLocalHourAndDay(tz, now)

  const dayAllowed = allowedDays.includes(currentDay)
  const hourAllowed = currentHour >= startHour && currentHour < endHour

  if (dayAllowed && hourAllowed) {
    return { allowed: true }
  }

  // Compute how many whole days ahead the next allowed day is (0 = today).
  let daysToAdd = 0
  if (!dayAllowed || currentHour >= endHour) {
    daysToAdd = 1
    let checkDay = (currentDay + 1) % 7
    while (!allowedDays.includes(checkDay) && daysToAdd < 8) {
      daysToAdd++
      checkDay = (currentDay + daysToAdd) % 7
    }
  }

  // Approximate the next valid send INSTANT from the tz wall-clock hour. This is
  // a defer-until hint (the executor re-checks the window at send time), so an
  // hour of DST slop is acceptable; the gating decision above is exact.
  const hoursUntil = daysToAdd * 24 + (startHour - currentHour)
  const nextValidTime = new Date(now.getTime() + hoursUntil * 60 * 60 * 1000)

  return { allowed: false, nextValidTime }
}

/**
 * Calculate the actual send time for a step, respecting delays and send windows.
 */
export function calculateNextStepTime(
  delayMinutes: number,
  sendWindow: Record<string, unknown> | null
): Date {
  const baseTime = new Date(Date.now() + delayMinutes * 60 * 1000)

  if (!sendWindow) return baseTime

  // Check if the calculated time falls within the send window
  // If not, push to the next valid time
  const check = checkSendWindow(sendWindow as any)
  if (check.allowed) return baseTime
  if (check.nextValidTime && check.nextValidTime > baseTime) return check.nextValidTime

  return baseTime
}
