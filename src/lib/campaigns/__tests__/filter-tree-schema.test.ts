/**
 * Advanced filter tree — schema + field-registry validation.
 *
 * The tree is the shared representation behind the Leads-page advanced search
 * and the Smart List builder. The field registry is the security boundary:
 * only registered fields, with their declared operators and value shapes, are
 * accepted — an unknown field name never reaches a query.
 */

import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { FILTER_FIELDS, filterNodeSchema } from '@/lib/campaigns/filter-tree'

describe('FILTER_FIELDS registry', () => {
  it('covers the Phase-1 dimensions the user asked for', () => {
    // pipeline status, demographics, location, conversation date, treatment
    for (const field of [
      'status', 'stage_id', 'age', 'city', 'state',
      'distance_to_practice_miles', 'service_line', 'conversation_activity',
    ]) {
      expect(FILTER_FIELDS[field], `missing registry entry: ${field}`).toBeTruthy()
    }
  })
})

describe('filterNodeSchema — conditions', () => {
  it('accepts a known field with an allowed operator and matching value', () => {
    const parsed = filterNodeSchema.safeParse({
      type: 'condition', field: 'city', operator: 'in', value: ['San Francisco', 'Oakland'],
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts a numeric between range', () => {
    const parsed = filterNodeSchema.safeParse({
      type: 'condition', field: 'age', operator: 'between', value: [30, 65],
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects an unknown field (no arbitrary columns)', () => {
    const parsed = filterNodeSchema.safeParse({
      type: 'condition', field: 'password_hash', operator: 'eq', value: 'x',
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects an operator the field does not allow', () => {
    // city is text — a numeric "between" is not a valid operator for it
    const parsed = filterNodeSchema.safeParse({
      type: 'condition', field: 'city', operator: 'between', value: [1, 2],
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects an "in" operator whose value is not an array', () => {
    const parsed = filterNodeSchema.safeParse({
      type: 'condition', field: 'status', operator: 'in', value: 'new',
    })
    expect(parsed.success).toBe(false)
  })
})

describe('filterNodeSchema — groups', () => {
  it('accepts a nested and/or group of conditions', () => {
    const tree = {
      type: 'group',
      op: 'and',
      children: [
        { type: 'condition', field: 'status', operator: 'in', value: ['new'] },
        {
          type: 'group',
          op: 'or',
          children: [
            { type: 'condition', field: 'state', operator: 'in', value: ['CA'] },
            { type: 'condition', field: 'age', operator: 'gte', value: 40 },
          ],
        },
      ],
    }
    expect(filterNodeSchema.safeParse(tree).success).toBe(true)
  })

  it('accepts a stage_id condition carrying uuids', () => {
    const parsed = filterNodeSchema.safeParse({
      type: 'group',
      op: 'or',
      children: [{ type: 'condition', field: 'stage_id', operator: 'in', value: [randomUUID()] }],
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects nesting deeper than the depth cap', () => {
    // Build a group nested 12 levels deep — beyond a sane cap.
    let node: unknown = { type: 'condition', field: 'age', operator: 'gte', value: 1 }
    for (let i = 0; i < 12; i++) node = { type: 'group', op: 'and', children: [node] }
    expect(filterNodeSchema.safeParse(node).success).toBe(false)
  })
})
