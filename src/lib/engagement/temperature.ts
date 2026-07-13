/**
 * Engagement temperature — the behavioral "how alive is this lead" meter.
 *
 * This is deliberately NOT the AI quality grade (`ai_score`/`ai_qualification`,
 * which judges how good a lead *could be*). Temperature measures what the lead
 * has actually DONE lately, from counters the messaging paths already maintain
 * (`last_responded_at`, `total_messages_received`, …), so it costs nothing to
 * compute and never goes stale behind an LLM queue.
 *
 * Bands (patient-initiated recency is the spine):
 *   - hot      replied within HOT_DAYS, or has an upcoming consultation
 *   - warm     replied within WARM_DAYS
 *   - cooling  replied within COOLING_DAYS — drifting, worth a nudge now
 *   - cold     no reply in > COOLING_DAYS (or never, once past the grace
 *              window) — this is the NURTURE pool
 *   - new      created within NEW_GRACE_DAYS and never replied — the jury is
 *              still out; fresh intake must not read as "cold"
 *
 * The 0-100 score is the sort key *within* a band (recency decay + conversation
 * depth + responsiveness + upcoming consult). Bands come from the recency rules
 * above, not from score cutoffs, so a chatty-then-silent lead can't sneak into
 * "warm" on volume alone.
 *
 * KEEP IN SYNC: supabase/migrations/*engagement_temperature*.sql implements the
 * exact same formula in SQL for the set-based sweep. If you tune a threshold
 * here, tune it there.
 */

export type EngagementTemperature = 'hot' | 'warm' | 'cooling' | 'cold' | 'new'

/** Replied this recently ⇒ hot. */
export const HOT_DAYS = 3
/** Replied this recently ⇒ warm. */
export const WARM_DAYS = 14
/** Replied this recently ⇒ cooling; beyond it ⇒ cold. */
export const COOLING_DAYS = 45
/** Never-replied leads younger than this read "new", not "cold". */
export const NEW_GRACE_DAYS = 14

/** The subset of `leads` columns the meter reads. */
export type EngagementInputs = {
  created_at: string
  last_responded_at: string | null
  last_contacted_at: string | null
  total_messages_received: number | null
  total_emails_opened: number | null
  response_time_avg_minutes: number | null
  consultation_date: string | null
}

export type EngagementResult = {
  score: number
  temperature: EngagementTemperature
}

const DAY_MS = 86_400_000

function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.max(0, (now.getTime() - t) / DAY_MS)
}

/** Upcoming (or today's) consultation is engagement regardless of SMS silence. */
function hasUpcomingConsult(lead: EngagementInputs, now: Date): boolean {
  if (!lead.consultation_date) return false
  const t = Date.parse(lead.consultation_date)
  // "Upcoming" includes today: compare against start of today so a 9am consult
  // still counts hot at noon.
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  return !Number.isNaN(t) && t >= startOfToday.getTime()
}

export function computeEngagement(lead: EngagementInputs, now: Date = new Date()): EngagementResult {
  const replyAge = daysSince(lead.last_responded_at, now)
  const createdAge = daysSince(lead.created_at, now) ?? Infinity
  const upcomingConsult = hasUpcomingConsult(lead, now)

  // ── Band ──────────────────────────────────────────────────────────────────
  let temperature: EngagementTemperature
  if (upcomingConsult || (replyAge !== null && replyAge <= HOT_DAYS)) {
    temperature = 'hot'
  } else if (replyAge !== null && replyAge <= WARM_DAYS) {
    temperature = 'warm'
  } else if (replyAge !== null && replyAge <= COOLING_DAYS) {
    temperature = 'cooling'
  } else if (replyAge === null && createdAge <= NEW_GRACE_DAYS) {
    temperature = 'new'
  } else {
    temperature = 'cold'
  }

  // ── Score (sort key within a band) ────────────────────────────────────────
  // Recency core: 55 pts decaying with a 14-day half-life-ish curve.
  const recency = replyAge === null ? 0 : 55 * Math.exp(-replyAge / 14)

  // Conversation depth: each inbound message is proof of engagement, capped so
  // a long-dead 40-message thread can't outrank a live short one.
  const depth = Math.min(lead.total_messages_received ?? 0, 10) * 2

  // Responsiveness: fast repliers get a small persistent bump.
  const avg = lead.response_time_avg_minutes
  const responsiveness = avg == null ? 0 : avg <= 60 ? 10 : avg <= 240 ? 6 : avg <= 1440 ? 3 : 0

  // Upcoming consult is the strongest commitment signal we have.
  const consult = upcomingConsult ? 15 : 0

  // Email opens: weak signal (no timestamp), tiny cap — enough to separate an
  // opener from a total ghost among never-replied leads.
  const opens = Math.min(lead.total_emails_opened ?? 0, 5)

  const score = Math.round(Math.min(100, recency + depth + responsiveness + consult + opens))
  return { score, temperature }
}

/** Display metadata shared by every surface that renders the meter. */
export const TEMPERATURE_META: Record<
  EngagementTemperature,
  { label: string; order: number }
> = {
  hot: { label: 'Hot', order: 0 },
  warm: { label: 'Warm', order: 1 },
  cooling: { label: 'Cooling', order: 2 },
  new: { label: 'New', order: 3 },
  cold: { label: 'Cold', order: 4 },
}
