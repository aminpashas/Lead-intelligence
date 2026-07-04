// Date-range presets for the Leads view. Leads are filtered on `created_at`,
// which is stored in UTC — but "today"/"yesterday" mean calendar days in the
// PRACTICE's timezone, not UTC (a lead created at 8pm Pacific is "today", even
// though it's already tomorrow in UTC). So cutoffs are computed as midnight in
// America/Los_Angeles and returned as UTC ISO strings for PostgREST .gte()/.lt().

// The practice (Dion Health, SF) operates in Pacific. Hard-coded rather than
// per-org because there's a single tenant today; lift to org settings if that
// changes.
const PRACTICE_TZ = 'America/Los_Angeles'

export type LeadDateRangeKey =
  | 'today'
  | 'yesterday'
  | '3d'
  | '7d'
  | '14d'
  | '30d'

// Label + how many calendar days back the window opens. `yesterday` is the only
// bounded window (it also closes at the start of today).
export const LEAD_DATE_RANGES: { value: LeadDateRangeKey; label: string; daysBack: number }[] = [
  { value: 'today', label: 'Today', daysBack: 0 },
  { value: 'yesterday', label: 'Yesterday', daysBack: 1 },
  { value: '3d', label: 'Past 3 days', daysBack: 2 },
  { value: '7d', label: 'Past week', daysBack: 6 },
  { value: '14d', label: 'Past 2 weeks', daysBack: 13 },
  { value: '30d', label: 'Past month', daysBack: 29 },
]

// Offset (ms) between `date` as seen in `timeZone` and UTC, DST-aware.
// e.g. LA in summer (PDT) → -25_200_000 (-7h); in winter (PST) → -28_800_000.
function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts: Record<string, string> = {}
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value
  // Intl gives hour "24" for midnight in some engines; normalize to 0.
  const hour = parts.hour === '24' ? '00' : parts.hour
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(hour),
    Number(parts.minute),
    Number(parts.second)
  )
  return asUTC - date.getTime()
}

// Midnight (start of day) in the practice timezone, `daysBack` calendar days
// before today, as a UTC Date.
function practiceMidnight(daysBack: number, now: Date): Date {
  // Today's calendar date in the practice tz (en-CA → YYYY-MM-DD).
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: PRACTICE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(now)
    .split('-')
    .map(Number)

  // Midnight-UTC of the target calendar date, then shift by the tz offset at
  // that instant so it lands on midnight *in the practice tz*.
  const midnightUTC = Date.UTC(y, m - 1, d - daysBack)
  const offset = tzOffsetMs(new Date(midnightUTC), PRACTICE_TZ)
  return new Date(midnightUTC - offset)
}

// Resolve a range key to created_at bounds. `gte` is inclusive lower bound;
// `lt` (present only for `yesterday`) is the exclusive upper bound. Returns
// null for unknown keys so callers can treat it as "all time".
export function resolveLeadDateRange(
  key: string,
  now: Date = new Date()
): { gte: string; lt?: string } | null {
  const preset = LEAD_DATE_RANGES.find((r) => r.value === key)
  if (!preset) return null

  const gte = practiceMidnight(preset.daysBack, now).toISOString()
  if (key === 'yesterday') {
    return { gte, lt: practiceMidnight(0, now).toISOString() }
  }
  return { gte }
}
