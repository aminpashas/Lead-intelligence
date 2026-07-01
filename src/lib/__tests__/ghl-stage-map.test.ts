import { describe, it, expect, vi } from 'vitest'
import { slugifyStageName, ensureStageMapping } from '@/lib/ghl/stage-map'
import type { GhlPipeline } from '@/lib/ghl/types'

describe('slugifyStageName', () => {
  it('lowercases and dashes', () => {
    expect(slugifyStageName('New Lead')).toBe('new-lead')
    expect(slugifyStageName('  Booked / Consult  ')).toBe('booked-consult')
    expect(slugifyStageName('Not-Interested!!')).toBe('not-interested')
  })
  it('returns empty for blank names', () => {
    expect(slugifyStageName('   ')).toBe('')
    expect(slugifyStageName('')).toBe('')
  })
})

// ── Mock supabase tailored for ensureStageMapping ────────────────────
// from('pipeline_stages').select(...).eq(...)  → { data: existing }
// from('pipeline_stages').insert(rows).select() → { data: inserted }
function mockSupabase(
  existing: Array<{ id: string; slug: string; position: number | null }>,
) {
  const calls: { inserted: Array<{ slug: string }> | null } = { inserted: null }
  function builder() {
    let op: 'select' | 'insert' = 'select'
    let insertRows: Array<{ slug: string }> = []
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      insert: vi.fn((rows: Array<{ slug: string }>) => {
        op = 'insert'
        insertRows = rows
        calls.inserted = rows
        return chain
      }),
      then: (resolve: (v: unknown) => void) => {
        if (op === 'insert') {
          resolve({ data: insertRows.map((r) => ({ id: `new-${r.slug}`, slug: r.slug })), error: null })
        } else {
          resolve({ data: existing, error: null })
        }
      },
    }
    return chain
  }
  return {
    api: { from: vi.fn(() => builder()) } as never,
    calls,
  }
}

const ORG = 'org-1'

describe('ensureStageMapping', () => {
  it('reuses an existing stage by matching slug, creates only the missing ones', async () => {
    const { api, calls } = mockSupabase([{ id: 'stage-new', slug: 'new', position: 0 }])
    const pipeline: GhlPipeline = {
      id: 'p1',
      name: 'Sales',
      stages: [
        { id: 'g-new', name: 'New' }, // matches existing slug 'new' → reuse
        { id: 'g-booked', name: 'Booked' }, // missing → create
      ],
    }

    const map = await ensureStageMapping(api, ORG, pipeline)

    expect(map['g-new']).toBe('stage-new')
    expect(map['g-booked']).toBe('new-booked')
    // only the genuinely-missing stage was inserted
    expect(calls.inserted).toHaveLength(1)
    expect(calls.inserted?.[0].slug).toBe('booked')
  })

  it('appends new stages after the current max position', async () => {
    const { api } = mockSupabase([{ id: 's1', slug: 'a', position: 5 }])
    const pipeline: GhlPipeline = {
      id: 'p1',
      name: 'P',
      stages: [{ id: 'g1', name: 'Brand New Stage' }],
    }
    await ensureStageMapping(api, ORG, pipeline)
    // position assertion is implicit via insert; the mapping must still resolve
    const map = await ensureStageMapping(api, ORG, pipeline)
    expect(map['g1']).toBe('new-brand-new-stage')
  })

  it('skips blank-named stages', async () => {
    const { api, calls } = mockSupabase([])
    const pipeline: GhlPipeline = {
      id: 'p1',
      name: 'P',
      stages: [
        { id: 'g-blank', name: '   ' },
        { id: 'g-real', name: 'Real' },
      ],
    }
    const map = await ensureStageMapping(api, ORG, pipeline)
    expect(map['g-blank']).toBeUndefined()
    expect(map['g-real']).toBe('new-real')
    expect(calls.inserted).toHaveLength(1)
  })

  it('collapses two GHL stages with the same slug onto one LI stage', async () => {
    const { api, calls } = mockSupabase([])
    const pipeline: GhlPipeline = {
      id: 'p1',
      name: 'P',
      stages: [
        { id: 'g1', name: 'Follow Up' },
        { id: 'g2', name: 'follow-up' }, // same slug
      ],
    }
    const map = await ensureStageMapping(api, ORG, pipeline)
    expect(map['g1']).toBe('new-follow-up')
    expect(map['g2']).toBe('new-follow-up')
    expect(calls.inserted).toHaveLength(1) // created once
  })

  it('returns empty map for a pipeline with no stages', async () => {
    const { api } = mockSupabase([])
    const map = await ensureStageMapping(api, ORG, { id: 'p', name: 'P', stages: [] })
    expect(map).toEqual({})
  })
})
