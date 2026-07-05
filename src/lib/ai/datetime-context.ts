/**
 * Current date + time awareness for the live agents.
 *
 * WHY THIS EXISTS: the setter, closer, dashboard command agent, and voice agent
 * book consultations and constantly talk timelines — "this Friday", "the 15th",
 * "early next month", "tomorrow", "later this afternoon". Two failures happen
 * without a clock in the prompt:
 *   1. With no date at all, the model anchors to its training cutoff — wrong day,
 *      offers dates that already passed, no idea it's a new month.
 *   2. Even WITH today's date, the model is unreliable at weekday→date
 *      arithmetic: it says "next Tuesday" but can't tell the patient the actual
 *      date, or computes the wrong one. So we hand it a pre-built dated calendar
 *      of the next two weeks and forbid it from computing dates itself.
 *
 * We anchor to the PRACTICE's timezone (booking_settings.timezone), NOT the UTC
 * server clock — otherwise "today" flips a day early every evening for US
 * practices and "now" is off by several hours.
 */

const DEFAULT_TZ = 'America/New_York'

/** Noon-UTC anchor renders the intended calendar day in the practice tz with no
 *  midnight/DST drift (same trick the booking-availability code uses). */
function zonedDate(offsetDays: number, base: Date): Date {
  return new Date(base.getTime() + offsetDays * 24 * 60 * 60 * 1000)
}

/**
 * A dated weekday calendar for the next `days` days, so the agent never has to
 * compute what date a relative day like "next Tuesday" falls on — it reads the
 * mapping directly. Returns lines like "Tuesday, July 8 (tomorrow)".
 */
export function buildUpcomingDatesList(timezone?: string | null, days = 14): string {
  const tz = timezone?.trim() || DEFAULT_TZ
  const now = new Date()
  // Anchor at noon UTC of "today" in the practice tz, then step whole days.
  const todayStr = safeFormat(now, tz, { year: 'numeric', month: '2-digit', day: '2-digit' })

  const lines: string[] = []
  for (let i = 0; i < days; i++) {
    const d = zonedDate(i, now)
    let label: string
    try {
      label = new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: tz,
      }).format(d)
    } catch {
      label = d.toDateString()
    }
    const rel = i === 0 ? ' (today)' : i === 1 ? ' (tomorrow)' : ''
    lines.push(`- ${label}${rel}`)
  }
  // todayStr is only referenced to keep the noon-anchor intent explicit; the loop
  // above is what produces the list.
  void todayStr
  return lines.join('\n')
}

function safeFormat(d: Date, tz: string, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz }).format(d)
  } catch {
    return new Intl.DateTimeFormat('en-US', opts).format(d)
  }
}

/**
 * The ground-truth block injected into text-based agents (setter, closer,
 * command). Voice uses `buildDateDynamicVariables` instead.
 */
export function buildCurrentDateBlock(timezone?: string | null): string {
  const tz = timezone?.trim() || DEFAULT_TZ
  const now = new Date()

  let formattedDate: string
  let formattedTime: string
  let dayOfMonth: string
  try {
    formattedDate = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: tz,
    }).format(now)
    formattedTime = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone: tz,
    }).format(now)
    dayOfMonth = new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: tz }).format(now)
  } catch {
    // Invalid tz string → format in server local time rather than crash the turn.
    formattedDate = now.toDateString()
    formattedTime = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    dayOfMonth = String(now.getDate())
  }

  return [
    "═══ CURRENT DATE & TIME (GROUND TRUTH) ═══",
    '',
    `Right now it is ${formattedTime} on ${formattedDate} (practice timezone: ${tz}). It is day ${dayOfMonth} of the month.`,
    '',
    'Calendar for the next two weeks — use these EXACT dates. NEVER work out a',
    "weekday's date in your head; look it up here:",
    buildUpcomingDatesList(tz),
    '',
    'Rules for talking about dates:',
    '- Whenever you name a day out loud, ALWAYS pair it with its calendar date',
    '  from the list above — say "Tuesday the 8th", never a bare "next Tuesday".',
    '- Never offer a day or time that has already passed.',
    '- Never guess or compute a date; if the day you want is not in the list',
    '  above, it is more than two weeks out — say so instead of inventing a date.',
    '- When you need actual open appointment slots, use the availability tool —',
    '  do not invent times.',
  ].join('\n')
}

/**
 * The same ground truth, shaped as Retell `retell_llm_dynamic_variables` for the
 * hosted voice agent. The Retell dashboard prompt must reference the variables:
 * `{{current_datetime}}` and `{{upcoming_dates}}`.
 */
export function buildDateDynamicVariables(timezone?: string | null): {
  current_datetime: string
  upcoming_dates: string
} {
  const tz = timezone?.trim() || DEFAULT_TZ
  const now = new Date()
  let current: string
  try {
    current = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone: tz,
    }).format(now)
  } catch {
    current = now.toString()
  }
  return {
    current_datetime: `${current} (practice time)`,
    upcoming_dates: buildUpcomingDatesList(tz),
  }
}
