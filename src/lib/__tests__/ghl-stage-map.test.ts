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

// ── Mock supabase tailored for ensureStageMapping (read-only) ────────
// from('pipeline_stages').select(...).eq(...)  → { data: existing }
// insert() must never be called — map-only. If it is, the test fails loudly.
function mockSupabase(
  existing: Array<{ id: string; slug: string; position: number | null }>,
) {
  const insert = vi.fn(() => {
    throw new Error('ensureStageMapping must not insert — LI owns the pipeline')
  })
  function builder() {
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      insert,
      then: (resolve: (v: unknown) => void) => resolve({ data: existing, error: null }),
    }
    return chain
  }
  return {
    api: { from: vi.fn(() => builder()) } as never,
    insert,
  }
}

const ORG = 'org-1'

describe('ensureStageMapping (map-only, LI owns the pipeline)', () => {
  it('maps a GHL stage onto the matching LI slug', async () => {
    const { api, insert } = mockSupabase([
      { id: 'stage-new', slug: 'new', position: 0 },
      { id: 'stage-booked', slug: 'booked', position: 1 },
    ])
    const pipeline: GhlPipeline = {
      id: 'p1',
      name: 'Sales',
      stages: [
        { id: 'g-new', name: 'New' },
        { id: 'g-booked', name: 'Booked' },
      ],
    }

    const map = await ensureStageMapping(api, ORG, pipeline)

    expect(map['g-new']).toBe('stage-new')
    expect(map['g-booked']).toBe('stage-booked')
    expect(insert).not.toHaveBeenCalled()
  })

  it('routes unrecognized GHL stages onto the intake column (lowest position)', async () => {
    const { api, insert } = mockSupabase([
      { id: 'stage-intake', slug: 'new', position: 0 },
      { id: 'stage-mid', slug: 'qualified', position: 2 },
    ])
    const pipeline: GhlPipeline = {
      id: 'p1',
      name: 'P',
      stages: [
        { id: 'g1', name: 'Brand New Stage' }, // no slug match → intake
        { id: 'g2', name: '2nd Attempt' }, // no slug match → intake
        { id: 'g3', name: 'Qualified' }, // matches → stage-mid
      ],
    }

    const map = await ensureStageMapping(api, ORG, pipeline)

    expect(map['g1']).toBe('stage-intake')
    expect(map['g2']).toBe('stage-intake')
    expect(map['g3']).toBe('stage-mid')
    expect(insert).not.toHaveBeenCalled()
  })

  it('routes blank-named stages onto the intake column too', async () => {
    const { api } = mockSupabase([{ id: 'stage-intake', slug: 'new', position: 0 }])
    const pipeline: GhlPipeline = {
      id: 'p1',
      name: 'P',
      stages: [
        { id: 'g-blank', name: '   ' },
        { id: 'g-real', name: 'New' },
      ],
    }
    const map = await ensureStageMapping(api, ORG, pipeline)
    expect(map['g-blank']).toBe('stage-intake')
    expect(map['g-real']).toBe('stage-intake')
  })

  it('collapses two GHL stages with the same slug onto one LI stage', async () => {
    const { api } = mockSupabase([
      { id: 'stage-intake', slug: 'new', position: 0 },
      { id: 'stage-follow', slug: 'follow-up', position: 3 },
    ])
    const pipeline: GhlPipeline = {
      id: 'p1',
      name: 'P',
      stages: [
        { id: 'g1', name: 'Follow Up' },
        { id: 'g2', name: 'follow-up' }, // same slug
      ],
    }
    const map = await ensureStageMapping(api, ORG, pipeline)
    expect(map['g1']).toBe('stage-follow')
    expect(map['g2']).toBe('stage-follow')
  })

  it('returns empty map for a pipeline with no stages', async () => {
    const { api } = mockSupabase([{ id: 'stage-intake', slug: 'new', position: 0 }])
    const map = await ensureStageMapping(api, ORG, { id: 'p', name: 'P', stages: [] })
    expect(map).toEqual({})
  })
})
