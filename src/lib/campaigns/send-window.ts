/**
 * Check if the current time is within a campaign's allowed send window.
 * Returns { allowed: true } or { allowed: false, nextValidTime: Date }.
 */
export function checkSendWindow(
  sendWindow: {
    start_hour?: number  // 0-23, default 9
    end_hour?: number    // 0-23, default 20
    timezone?: string    // IANA timezone, default 'America/New_York'
    days?: number[]      // 0=Sun, 1=Mon...6=Sat. Default [1,2,3,4,5] (weekdays)
  } | null
): { allowed: boolean; nextValidTime?: Date } {
  if (!sendWindow) return { allowed: true } // No window = always allowed

  const tz = sendWindow.timezone || 'America/New_York'
  const startHour = sendWindow.start_hour ?? 9
  const endHour = sendWindow.end_hour ?? 20
  const allowedDays = sendWindow.days ?? [1, 2, 3, 4, 5]

  // Get current time in the target timezone
  const now = new Date()
  const tzNow = new Date(now.toLocaleString('en-US', { timeZone: tz }))
  const currentHour = tzNow.getHours()
  const currentDay = tzNow.getDay() // 0=Sun

  // Check if current day is allowed
  const dayAllowed = allowedDays.includes(currentDay)

  // Check if current hour is within window
  const hourAllowed = currentHour >= startHour && currentHour < endHour

  if (dayAllowed && hourAllowed) {
    return { allowed: true }
  }

  // Calculate next valid send time
  const next = new Date(tzNow)

  if (!dayAllowed || currentHour >= endHour) {
    // Move to next allowed day
    let daysToAdd = 1
    let checkDay = (currentDay + 1) % 7
    while (!allowedDays.includes(checkDay) && daysToAdd < 8) {
      daysToAdd++
      checkDay = (currentDay + daysToAdd) % 7
    }
    next.setDate(next.getDate() + daysToAdd)
    next.setHours(startHour, 0, 0, 0)
  } else if (currentHour < startHour) {
    // Same day, wait until start hour
    next.setHours(startHour, 0, 0, 0)
  }

  return { allowed: false, nextValidTime: next }
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
