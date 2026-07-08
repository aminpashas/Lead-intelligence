import type { Lead } from '@/types/database'
import type { ClosingTemperature } from '@/lib/pipeline/closing'

/**
 * Closing-book helpers — the logic behind the sheet-driven /closing board.
 *
 * The board's population is the `closing_book` table (a curated list seeded from
 * the practice's "Case Follow ups" spreadsheet), not a pipeline-stage query. The
 * sheet carried a free-text "gut feel" cell — "maybe", "Super cold", "CLOSED",
 * sometimes just a location note. `normalizeSheetStatus` turns that into the two
 * signals the CRM actually tracks: a closing temperature and a close
 * probability. Kept pure so it unit-tests without mocks and is the single source
 * of truth shared by the one-time seed.
 */

/** A row of the `closing_book` table. */
export type ClosingBookRow = {
  id: string
  organization_id: string
  lead_id: string | null
  first_name: string
  last_name: string
  service: string | null
  case_value: number | null
  status_raw: string | null
  temperature: ClosingTemperature | null
  close_probability: number | null
  won: boolean
  next_step: string | null
  status_note: string | null
  last_contact_at: string | null
  sort_order: number
  source: string
}

/** A closing-book row joined with its optional CRM lead, ready for the board. */
export type ClosingRow = {
  id: string
  firstName: string
  lastName: string
  service: string | null
  caseValue: number | null
  statusRaw: string | null
  /** Manual override; when null the board shows `derivedTemperature`. */
  temperature: ClosingTemperature | null
  derivedTemperature: ClosingTemperature
  closeProbability: number
  won: boolean
  nextStep: string
  daysSinceContact: number | null
  leadId: string | null
  /** Present only when the row is unambiguously linked to a CRM lead. */
  lead: Lead | null
}

/**
 * Default close probability by temperature — the fallback when a row has no
 * seeded probability (e.g. a row added by hand later). Grounded in the same gut
 * feel the temperature encodes.
 */
export const TEMP_PROBABILITY: Record<ClosingTemperature, number> = {
  hot: 0.6,
  warm: 0.4,
  cold: 0.15,
  stalled: 0.05,
}

type NormalizedStatus = {
  /** Temperature override, or null to let the board derive it. */
  temperature: ClosingTemperature | null
  closeProbability: number
  won: boolean
  /** Leftover text that wasn't a recognized temperature (e.g. "in cambodia"). */
  note: string | null
}

/**
 * Map the sheet's free-text gut-feel cell to structured signals.
 *
 * The cell is inconsistent by nature (staff shorthand). Recognized keywords map
 * to a temperature + probability; a closed deal is flagged won; anything else is
 * treated as a note and left temperature-less so the board derives it.
 */
export function normalizeSheetStatus(raw: string | null | undefined): NormalizedStatus {
  const s = (raw ?? '').trim().toLowerCase()
  if (!s) return { temperature: null, closeProbability: TEMP_PROBABILITY.cold, won: false, note: null }

  if (s === 'closed' || s === 'won') {
    return { temperature: 'hot', closeProbability: 1, won: true, note: null }
  }
  // "super cold" is still cold, just less likely — check before plain "cold".
  if (s.includes('super cold')) {
    return { temperature: 'cold', closeProbability: 0.08, won: false, note: null }
  }
  if (s === 'no' || s === 'not interested' || s === 'declined') {
    return { temperature: 'stalled', closeProbability: 0.03, won: false, note: null }
  }
  if (s.includes('cold')) {
    return { temperature: 'cold', closeProbability: 0.15, won: false, note: null }
  }
  if (s === 'maybe') {
    return { temperature: 'warm', closeProbability: 0.5, won: false, note: null }
  }
  if (s === 'hot') {
    return { temperature: 'hot', closeProbability: 0.6, won: false, note: null }
  }
  if (s === 'warm') {
    return { temperature: 'warm', closeProbability: 0.4, won: false, note: null }
  }
  // Not a temperature — it's a note the staff parked in this column.
  return { temperature: null, closeProbability: TEMP_PROBABILITY.cold, won: false, note: raw!.trim() }
}

/** Excel's 1900 date system counts days from 1899-12-30 (the leap-year bug baseline). */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)

/**
 * Parse the sheet's "Date of last Contact" cell to an ISO date (yyyy-mm-dd).
 *
 * Values arrive two ways: Excel serial numbers ("46199") from date-typed cells,
 * and hand-typed strings ("6/26//26", note the stray slash). Returns null for
 * anything unparseable rather than guessing.
 */
export function parseSheetDate(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim()
  if (!s) return null

  // Excel serial (an integer-ish number in a plausible modern range).
  const num = Number(s)
  if (Number.isFinite(num) && num > 20000 && num < 80000) {
    const iso = new Date(EXCEL_EPOCH_MS + Math.round(num) * 86_400_000).toISOString()
    return iso.slice(0, 10)
  }

  // Hand-typed M/D/YY — tolerate a stray extra slash ("6/26//26").
  const m = s.replace(/\/+/g, '/').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (m) {
    const mo = Number(m[1])
    const day = Number(m[2])
    let yr = Number(m[3])
    if (yr < 100) yr += 2000
    if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
      const iso = new Date(Date.UTC(yr, mo - 1, day)).toISOString()
      return iso.slice(0, 10)
    }
  }
  return null
}

/** The close probability to use for a row: its seeded value, else by temperature. */
export function rowCloseProbability(
  seeded: number | null | undefined,
  temperature: ClosingTemperature
): number {
  if (typeof seeded === 'number' && Number.isFinite(seeded)) return seeded
  return TEMP_PROBABILITY[temperature]
}
