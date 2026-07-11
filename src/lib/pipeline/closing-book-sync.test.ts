import { describe, it, expect } from 'vitest'
import { planClosingBookSync, caseKey, SYNC_SOURCE, type SheetCase, type ExistingRow } from './closing-book-sync'

function sheetCase(over: Partial<SheetCase> = {}): SheetCase {
  return {
    firstName: 'Jane',
    lastName: 'Doe',
    service: 'Upper AOX',
    cost: 18000,
    lastContactRaw: null,
    gutFeel: null,
    narrative: null,
    strategy: null,
    notes: null,
    ...over,
  }
}

function existingRow(over: Partial<ExistingRow> = {}): ExistingRow {
  return {
    id: 'row-1',
    first_name: 'Jane',
    last_name: 'Doe',
    service: 'Upper AOX',
    case_value: 18000,
    status_raw: null,
    won: false,
    last_contact_at: null,
    source: SYNC_SOURCE,
    ...over,
  }
}

describe('caseKey', () => {
  it('is case- and whitespace-insensitive', () => {
    expect(caseKey('  Jane ', 'DOE')).toBe(caseKey('jane', 'doe'))
  })
})

describe('planClosingBookSync', () => {
  it('inserts a sheet case with no matching row, with full seed semantics', () => {
    const plan = planClosingBookSync(
      [sheetCase({ firstName: 'Chao', lastName: 'Yin', cost: 90000, gutFeel: 'cold', strategy: 'email plan' })],
      []
    )
    expect(plan.inserts).toHaveLength(1)
    const ins = plan.inserts[0]
    expect(ins).toMatchObject({
      first_name: 'Chao',
      last_name: 'Yin',
      case_value: 90000,
      temperature: 'cold',
      won: false,
      next_step: 'email plan',
      source: SYNC_SOURCE,
    })
    expect(plan.updates).toHaveLength(0)
    expect(plan.deletes).toHaveLength(0)
  })

  it('counts an identical row as unchanged (idempotent re-run)', () => {
    const plan = planClosingBookSync([sheetCase()], [existingRow()])
    expect(plan.unchanged).toBe(1)
    expect(plan.inserts).toHaveLength(0)
    expect(plan.updates).toHaveLength(0)
    expect(plan.deletes).toHaveLength(0)
  })

  it('updates only the changed objective field', () => {
    // Karen Silva case: value was null in the table, sheet now has 46111.
    const plan = planClosingBookSync(
      [sheetCase({ firstName: 'Karen', lastName: 'Silva', service: 'AOX', cost: 46111 })],
      [existingRow({ id: 'silva', first_name: 'Karen', last_name: 'Silva', service: 'AOX', case_value: null })]
    )
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0]).toMatchObject({ id: 'silva', changes: { case_value: 46111 } })
    // Only case_value changed — service was already equal.
    expect(Object.keys(plan.updates[0].changes)).toEqual(['case_value'])
  })

  it('syncs the won flag when the sheet marks a deal closed', () => {
    const plan = planClosingBookSync(
      [sheetCase({ firstName: 'Byron', lastName: 'Barrera', cost: 15000, gutFeel: 'CLOSED' })],
      [existingRow({ id: 'b', first_name: 'Byron', last_name: 'Barrera', case_value: 15000, won: false })]
    )
    expect(plan.updates[0].changes).toEqual({ won: true })
  })

  it('parses an ISO datetime last-contact into an inserted row (CSV export shape)', () => {
    const plan = planClosingBookSync(
      [sheetCase({ firstName: 'New', lastName: 'Patient', lastContactRaw: '2026-06-26 00:00:00' })],
      []
    )
    expect(plan.inserts[0].last_contact_at).toBe('2026-06-26')
  })

  it('deletes a SYNC_SOURCE row that dropped off the sheet', () => {
    const plan = planClosingBookSync(
      [],
      [existingRow({ id: 'gone', first_name: 'Cyrus', last_name: 'Ansari' })]
    )
    expect(plan.deletes).toEqual([{ id: 'gone', first_name: 'Cyrus', last_name: 'Ansari' }])
  })

  it('never touches rows of another source', () => {
    const plan = planClosingBookSync(
      [],
      [existingRow({ id: 'manual', source: 'hand-added' })]
    )
    expect(plan.deletes).toHaveLength(0)
    expect(plan.unchanged).toBe(0)
  })

  it('preserves in-app edits: temperature/next_step are not part of any update', () => {
    // Sheet gut-feel says "cold", but staff may have overridden temperature in
    // the UI. An update must carry only objective fields, never temperature.
    const plan = planClosingBookSync(
      [sheetCase({ cost: 20000, gutFeel: 'cold' })],
      [existingRow({ case_value: 18000 })]
    )
    expect(plan.updates[0].changes).toEqual({ case_value: 20000 })
    expect(plan.updates[0].changes).not.toHaveProperty('temperature')
    expect(plan.updates[0].changes).not.toHaveProperty('next_step')
  })
})
