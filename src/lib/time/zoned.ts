/**
 * Timezone-deterministic timestamp formatting for message/activity threads.
 *
 * Bare `date-fns` `format()` / `isToday()` render in the AMBIENT timezone. That
 * differs between the server (UTC on Vercel) and the browser (the viewer's tz),
 * so SSR and hydration disagree — an evening-Pacific message (next-day UTC)
 * gets first-painted under the wrong calendar day. We instead pin every thread
 * timestamp to a FIXED practice timezone so server and client always agree.
 *
 * Implementation uses `Intl.DateTimeFormat`, which carries the full IANA tz
 * database — no extra dependency, same approach as src/lib/booking/timezone.ts.
 */

/** Sensible fallback when a practice hasn't configured its booking timezone. */
export const DEFAULT_PRACTICE_TIMEZONE = 'America/Los_Angeles'

/** `YYYY-MM-DD` for `instant` as seen in `timeZone` (en-CA yields ISO order). */
export function zonedDayKey(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant)
}

/** Wall-clock time in `timeZone`, e.g. "9:56 AM". */
export function zonedTimeLabel(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(instant)
}

/** Short date in `timeZone`, e.g. "Jul 5". */
export function zonedDateLabel(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
  }).format(instant)
}

/** Date + time in `timeZone`, e.g. "Jul 5, 9:56 AM" (message hover title). */
export function zonedDateTimeLabel(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(instant)
}

/**
 * Day-divider label in `timeZone`: "Today" / "Yesterday" / "Wednesday, Jul 1".
 * `now` is injectable for testing; day comparison is done on the zoned day key
 * so it stays correct regardless of the server's own timezone.
 */
export function zonedDayDivider(instant: Date, timeZone: string, now: Date = new Date()): string {
  const key = zonedDayKey(instant, timeZone)
  if (key === zonedDayKey(now, timeZone)) return 'Today'
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  if (key === zonedDayKey(yesterday, timeZone)) return 'Yesterday'
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  }).format(instant)
}
