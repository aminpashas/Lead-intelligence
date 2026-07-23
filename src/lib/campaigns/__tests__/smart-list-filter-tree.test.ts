/**
 * Smart List criteria ↔ advanced filter tree integration.
 * The saved `criteria` may carry a `filter` tree (advanced search) alongside the
 * legacy flat keys. The tree is validated by the field registry, and the latent
 * `service_line` key (present in the TS type + resolver, previously unvalidated)
 * is now accepted.
 */

import { describe, expect, it } from 'vitest'
import { smartListCriteriaSchema } from '@/lib/validators/smart-list'

describe('smartListCriteriaSchema — filter tree', () => {
  it('accepts a valid advanced filter tree', () => {
    const parsed = smartListCriteriaSchema.safeParse({
      filter: {
        type: 'group', op: 'and',
        children: [
          { type: 'condition', field: 'status', operator: 'in', value: ['new'] },
          { type: 'condition', field: 'age', operator: 'between', value: [30, 65] },
          { type: 'condition', field: 'conversation_activity', operator: 'after', value: '2026-06-01' },
        ],
      },
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a filter tree that references an unknown field', () => {
    const parsed = smartListCriteriaSchema.safeParse({
      filter: {
        type: 'group', op: 'and',
        children: [{ type: 'condition', field: 'ssn', operator: 'eq', value: '1' }],
      },
    })
    expect(parsed.success).toBe(false)
  })

  it('accepts the (previously unvalidated) service_line key', () => {
    const parsed = smartListCriteriaSchema.safeParse({ service_line: 'tmj' })
    expect(parsed.success).toBe(true)
  })

  it('still accepts legacy flat criteria with no filter tree', () => {
    const parsed = smartListCriteriaSchema.safeParse({ statuses: ['new'], score_min: 50 })
    expect(parsed.success).toBe(true)
  })
})
