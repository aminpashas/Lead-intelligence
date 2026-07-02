/**
 * Timezone-correct helpers for booking.
 *
 * A practice configures its hours in ITS OWN timezone ("we're open 9–5"),
 * but appointments are stored as absolute UTC instants (`timestamptz`).
 * These helpers convert between the two WITHOUT depending on the server's
 * local timezone (which is UTC on Vercel) and while respecting DST.
 *
 * Implementation uses `Intl.DateTimeFormat`, which knows the full IANA tz
 * database — no extra dependency required.
 */

export type ZonedParts = {
  year: number
  month: number // 1-12
  day: number // 1-31
  weekday: number // 0=Sun … 6=Sat
  hour: number // 0-23
  minute: number // 0-59
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}

/**
 * The offset (in ms) of `timeZone` from UTC at the given instant.
 * Positive east of UTC. e.g. America/Los_Angeles in July → -7h.
 */
function tzOffsetMs(timeZone: string, instant: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = dtf.formatToParts(instant)
  const map: Record<string, string> = {}
  for (const p of parts) map[p.type] = p.value
  // The wall-clock time this instant shows in `timeZone`, read back as if UTC.
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  )
  return asUTC - instant.getTime()
}

/**
 * Convert a wall-clock date + time in `timeZone` to the absolute UTC instant.
 *
 * @param dateStr YYYY-MM-DD (in the practice timezone)
 * @param timeStr HH:MM (24h, in the practice timezone)
 */
export function zonedTimeToUtc(dateStr: string, timeStr: string, timeZone: string): Date {
  const [y, mo, d] = dateStr.split('-').map(Number)
  const [h, mi] = timeStr.split(':').map(Number)

  // First guess: treat the wall time as if it were UTC, then subtract the
  // zone offset at that (approximate) instant. Recompute once to settle DST
  // boundaries where the offset at the guess differs from the offset at the
  // resolved instant.
  const guessUtc = Date.UTC(y, mo - 1, d, h, mi)
  let offset = tzOffsetMs(timeZone, new Date(guessUtc))
  let resolved = guessUtc - offset
  const offset2 = tzOffsetMs(timeZone, new Date(resolved))
  if (offset2 !== offset) {
    offset = offset2
    resolved = guessUtc - offset
  }
  return new Date(resolved)
}

/**
 * Break an absolute UTC instant into wall-clock parts in `timeZone`.
 */
export function getZonedParts(instant: Date, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  const map: Record<string, string> = {}
  for (const p of dtf.formatToParts(instant)) map[p.type] = p.value
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    weekday: WEEKDAY_INDEX[map.weekday] ?? 0,
    hour: Number(map.hour),
    minute: Number(map.minute),
  }
}
