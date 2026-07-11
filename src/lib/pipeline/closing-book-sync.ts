import { normalizeSheetStatus, parseSheetDate, rowCloseProbability } from './closing-book'
import type { ClosingTemperature } from './closing'

/**
 * Closing-book sync — the reconcile logic that keeps the `closing_book` table in
 * step with the practice's hand-maintained "Case Follow ups" sheet.
 *
 * The sheet is edited daily, so the seeded table drifts within days. This module
 * computes an idempotent reconcile PLAN (inserts / updates / deletes) from a
 * parsed sheet + the current table. It's pure — no DB, no I/O — so it unit-tests
 * without mocks and is shared by the CLI sync script and any future upload UI.
 *
 * Ownership rule (why updates are narrow): the board lets staff override two
 * fields in-app — `temperature` and `next_step` (PATCHed to /api/closing/[id]).
 * A re-sync MUST NOT clobber those human edits. So on an existing row we refresh
 * only the OBJECTIVE sheet facts (case value, service, status text, won,
 * last-contact); temperature and next_step are set from the sheet ONLY when the
 * row is first inserted, then left alone forever.
 */

/** One parsed row of the "Case Follow ups" tab. */
export type SheetCase = {
  firstName: string
  lastName: string
  service: string | null
  cost: number | null
  lastContactRaw: string | null
  /** Short flag column ("closed", "cold", "CLOSED", …) → temperature/won. */
  gutFeel: string | null
  /** Free-text status narrative ("lvm/text no answer", "Down Payment Pending"). */
  narrative: string | null
  /** "Strategy" column — seeds next_step on insert only. */
  strategy: string | null
  /** Overflow "Notes" column. */
  notes: string | null
}

/** The subset of a `closing_book` row the planner needs to diff against. */
export type ExistingRow = {
  id: string
  first_name: string
  last_name: string
  service: string | null
  case_value: number | null
  status_raw: string | null
  won: boolean
  last_contact_at: string | null
  source: string
}

/** Objective fields a sync is allowed to refresh on an existing row. */
export type SyncableFields = {
  service: string | null
  case_value: number | null
  status_raw: string | null
  won: boolean
  last_contact_at: string | null
}

/** A full row to insert (org id + generated id are added by the caller). */
export type InsertRow = SyncableFields & {
  first_name: string
  last_name: string
  temperature: ClosingTemperature | null
  close_probability: number
  next_step: string | null
  status_note: string | null
  sort_order: number
  source: string
}

export type PlannedUpdate = {
  id: string
  first_name: string
  last_name: string
  /** Only the fields that actually changed. */
  changes: Partial<SyncableFields>
}

export type PlannedDelete = { id: string; first_name: string; last_name: string }

export type SyncPlan = {
  inserts: InsertRow[]
  updates: PlannedUpdate[]
  deletes: PlannedDelete[]
  unchanged: number
}

/** Rows this sync owns. Hand-added rows of another source are never touched. */
export const SYNC_SOURCE = 'case-follow-ups'

/** Normalized identity for matching a sheet row to a table row. */
export function caseKey(first: string, last: string): string {
  return `${first.trim().toLowerCase()}|${last.trim().toLowerCase()}`
}

/** The objective fields a sheet case maps to, for diffing against the table. */
function syncableFromSheet(c: SheetCase): SyncableFields {
  const { won } = normalizeSheetStatus(c.gutFeel)
  return {
    service: c.service?.trim() || null,
    case_value: c.cost,
    // The board's Status column renders status_raw; keep it the narrative.
    status_raw: c.narrative?.trim() || null,
    won,
    last_contact_at: parseSheetDate(c.lastContactRaw),
  }
}

/**
 * Compute an idempotent reconcile plan.
 *
 * @param cases   parsed sheet rows (the source of truth)
 * @param existing current `closing_book` rows for the org
 *
 * - A sheet case with no matching row → INSERT (full seed semantics).
 * - A sheet case matching a row → UPDATE of only the changed objective fields
 *   (temperature / next_step preserved); no diff → counted unchanged.
 * - A SYNC_SOURCE row with no matching sheet case → DELETE (patient left the
 *   sheet). Rows of any other source are left untouched.
 */
export function planClosingBookSync(cases: SheetCase[], existing: ExistingRow[]): SyncPlan {
  const byKey = new Map<string, ExistingRow>()
  for (const r of existing) {
    if (r.source === SYNC_SOURCE) byKey.set(caseKey(r.first_name, r.last_name), r)
  }

  const inserts: InsertRow[] = []
  const updates: PlannedUpdate[] = []
  let unchanged = 0
  const seen = new Set<string>()

  cases.forEach((c, i) => {
    const key = caseKey(c.firstName, c.lastName)
    seen.add(key)
    const want = syncableFromSheet(c)
    const row = byKey.get(key)

    if (!row) {
      const norm = normalizeSheetStatus(c.gutFeel)
      const noteParts = [norm.note, c.notes?.trim()].filter((x): x is string => !!x)
      inserts.push({
        first_name: c.firstName.trim(),
        last_name: c.lastName.trim(),
        ...want,
        temperature: norm.temperature,
        close_probability: rowCloseProbability(norm.closeProbability, norm.temperature ?? 'cold'),
        next_step: c.strategy?.trim() || null,
        status_note: noteParts.length ? noteParts.join(' — ') : null,
        sort_order: i,
        source: SYNC_SOURCE,
      })
      return
    }

    const changes: Partial<SyncableFields> = {}
    if (want.service !== row.service) changes.service = want.service
    if (want.case_value !== row.case_value) changes.case_value = want.case_value
    if (want.status_raw !== row.status_raw) changes.status_raw = want.status_raw
    if (want.won !== row.won) changes.won = want.won
    if (want.last_contact_at !== row.last_contact_at) changes.last_contact_at = want.last_contact_at

    if (Object.keys(changes).length === 0) unchanged++
    else updates.push({ id: row.id, first_name: row.first_name, last_name: row.last_name, changes })
  })

  const deletes: PlannedDelete[] = []
  for (const [key, r] of byKey) {
    if (!seen.has(key)) deletes.push({ id: r.id, first_name: r.first_name, last_name: r.last_name })
  }

  return { inserts, updates, deletes, unchanged }
}
