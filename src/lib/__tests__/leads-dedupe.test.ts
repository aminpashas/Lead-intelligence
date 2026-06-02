import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the encryption module
vi.mock('@/lib/encryption', () => ({
  searchHash: vi.fn((val: string | null | undefined) => {
    if (val == null || val === '') return null
    return `hash_${val.toLowerCase().trim()}`
  }),
}))

import { findExistingLeads, type DedupeRow } from '@/lib/leads/dedupe'

// ── Supabase mock builder ────────────────────────────────────────

function createMockSupabase(existingLeads: Array<{ id: string; email_hash: string | null; phone_hash: string | null }> = []) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    then: undefined as unknown,
  }
  // Make the chain thenable so `await query` resolves to { data: existingLeads }
  Object.defineProperty(chain, 'then', {
    value: (resolve: (v: unknown) => void) => resolve({ data: existingLeads }),
    writable: true,
  })

  return {
    from: vi.fn().mockReturnValue(chain),
    _chain: chain,
  } as unknown as ReturnType<typeof import('@supabase/supabase-js').createClient>
}

describe('findExistingLeads', () => {
  const ORG_ID = 'org-123'

  it('returns empty map when all rows have no email/phone', async () => {
    const supabase = createMockSupabase()
    const rows: DedupeRow[] = [
      { email: null, phone_formatted: null },
      { email: undefined, phone_formatted: undefined },
    ]

    const result = await findExistingLeads(supabase as any, ORG_ID, rows)

    expect(result.size).toBe(0)
  })

  it('returns empty map when rows array is empty', async () => {
    const supabase = createMockSupabase()
    const result = await findExistingLeads(supabase as any, ORG_ID, [])
    expect(result.size).toBe(0)
  })

  it('matches by email hash', async () => {
    const supabase = createMockSupabase([
      { id: 'lead-1', email_hash: 'hash_john@example.com', phone_hash: null },
    ])

    const rows: DedupeRow[] = [
      { email: 'john@example.com', phone_formatted: null },
      { email: 'unique@example.com', phone_formatted: null },
    ]

    const result = await findExistingLeads(supabase as any, ORG_ID, rows)

    expect(result.size).toBe(1)
    expect(result.get(0)).toEqual({ id: 'lead-1', matchedOn: 'email' })
    expect(result.has(1)).toBe(false)
  })

  it('matches by phone hash', async () => {
    const supabase = createMockSupabase([
      { id: 'lead-2', email_hash: null, phone_hash: 'hash_+14155551234' },
    ])

    const rows: DedupeRow[] = [
      { email: null, phone_formatted: '+14155551234' },
    ]

    const result = await findExistingLeads(supabase as any, ORG_ID, rows)

    expect(result.size).toBe(1)
    expect(result.get(0)).toEqual({ id: 'lead-2', matchedOn: 'phone' })
  })

  it('prioritises email match when both email and phone match (first-wins)', async () => {
    const supabase = createMockSupabase([
      { id: 'lead-3', email_hash: 'hash_both@test.com', phone_hash: 'hash_+10000000000' },
    ])

    const rows: DedupeRow[] = [
      { email: 'both@test.com', phone_formatted: '+10000000000' },
    ]

    const result = await findExistingLeads(supabase as any, ORG_ID, rows)

    expect(result.size).toBe(1)
    // Email match is processed first in the loop
    expect(result.get(0)?.matchedOn).toBe('email')
  })

  it('uses .or() filter when both email AND phone hashes exist', async () => {
    const supabase = createMockSupabase([])
    const rows: DedupeRow[] = [
      { email: 'a@b.com', phone_formatted: '+1000' },
    ]

    await findExistingLeads(supabase as any, ORG_ID, rows)

    const chain = (supabase as any)._chain
    expect(chain.or).toHaveBeenCalledTimes(1)
  })

  it('uses .in(email_hash) when only emails exist', async () => {
    const supabase = createMockSupabase([])
    const rows: DedupeRow[] = [
      { email: 'only@email.com', phone_formatted: null },
    ]

    await findExistingLeads(supabase as any, ORG_ID, rows)

    const chain = (supabase as any)._chain
    expect(chain.in).toHaveBeenCalledWith('email_hash', ['hash_only@email.com'])
  })

  it('uses .in(phone_hash) when only phones exist', async () => {
    const supabase = createMockSupabase([])
    const rows: DedupeRow[] = [
      { email: null, phone_formatted: '+15551234' },
    ]

    await findExistingLeads(supabase as any, ORG_ID, rows)

    const chain = (supabase as any)._chain
    expect(chain.in).toHaveBeenCalledWith('phone_hash', ['hash_+15551234'])
  })

  it('deduplicates hash keys — only stores first row index per hash', async () => {
    const supabase = createMockSupabase([
      { id: 'lead-dup', email_hash: 'hash_same@email.com', phone_hash: null },
    ])

    const rows: DedupeRow[] = [
      { email: 'same@email.com', phone_formatted: null },
      { email: 'same@email.com', phone_formatted: null }, // duplicate
    ]

    const result = await findExistingLeads(supabase as any, ORG_ID, rows)

    expect(result.size).toBe(1)
    // Should match row index 0, not 1 (first occurrence wins)
    expect(result.get(0)).toEqual({ id: 'lead-dup', matchedOn: 'email' })
    expect(result.has(1)).toBe(false)
  })

  it('handles null data from Supabase gracefully', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
    }
    Object.defineProperty(chain, 'then', {
      value: (resolve: (v: unknown) => void) => resolve({ data: null }),
      writable: true,
    })

    const supabase = { from: vi.fn().mockReturnValue(chain) }

    const rows: DedupeRow[] = [{ email: 'test@test.com', phone_formatted: null }]
    const result = await findExistingLeads(supabase as any, ORG_ID, rows)

    expect(result.size).toBe(0)
  })

  it('matches multiple rows across different leads', async () => {
    const supabase = createMockSupabase([
      { id: 'lead-A', email_hash: 'hash_a@test.com', phone_hash: null },
      { id: 'lead-B', email_hash: null, phone_hash: 'hash_+19991234' },
    ])

    const rows: DedupeRow[] = [
      { email: 'a@test.com', phone_formatted: null },
      { email: 'no-match@test.com', phone_formatted: null },
      { email: null, phone_formatted: '+19991234' },
    ]

    const result = await findExistingLeads(supabase as any, ORG_ID, rows)

    expect(result.size).toBe(2)
    expect(result.get(0)).toEqual({ id: 'lead-A', matchedOn: 'email' })
    expect(result.get(2)).toEqual({ id: 'lead-B', matchedOn: 'phone' })
  })
})
