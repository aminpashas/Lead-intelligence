/**
 * Current-date awareness for the live agents.
 *
 * WHY THIS EXISTS: the setter and closer book consultations and constantly talk
 * timelines — "this Friday", "the 15th", "early next month", "tomorrow". With no
 * date in the prompt the model anchors to its training cutoff: it guesses the
 * wrong day, offers dates that already passed, and has no idea we've rolled into
 * a new month. Giving it today's date (as ground truth) fixes all of that.
 *
 * We anchor to the PRACTICE's timezone (booking_settings.timezone), NOT the UTC
 * server clock — otherwise "today" flips a day early every evening for US practices.
 */
export function buildCurrentDateBlock(timezone?: string | null): string {
  const tz = timezone?.trim() || 'America/New_York'
  const now = new Date()

  let formatted: string
  let dayOfMonth: string
  try {
    formatted = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: tz,
    }).format(now)
    dayOfMonth = new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: tz }).format(now)
  } catch {
    // Invalid tz string → format in server local time rather than crash the turn.
    formatted = now.toDateString()
    dayOfMonth = String(now.getDate())
  }

  return [
    "═══ TODAY'S DATE (GROUND TRUTH) ═══",
    '',
    `Today is ${formatted} (practice timezone: ${tz}). It is day ${dayOfMonth} of the month.`,
    'Use this as the source of truth whenever a date or timeline comes up — "today",',
    '"tomorrow", "this week", "next Tuesday", "the 15th", "end of the month". Never guess',
    'the date and never offer a day that has already passed. When you need actual open',
    'appointment slots, use the availability tool — do not invent times.',
  ].join('\n')
}
