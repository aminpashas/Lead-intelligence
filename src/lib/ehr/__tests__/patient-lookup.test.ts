import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getPatientInboundState } from '@/lib/ehr/patient-lookup'

/**
 * These pin the inbound-call classification: given a caller's phone hashes, do we
 * correctly decide (a) is this a synced patient at all, and (b) are they in ACTIVE
 * treatment (accepted/completed case) vs. a consult/exam prospect. The routing that
 * sends a live patient to the office manager hangs entirely on inActiveTreatment,
 * so the accepted-vs-proposed boundary is asserted explicitly.
 */

type Captured = {
  eq: Record<string, unknown>
  in: Record<string, unknown[]>
  contains: unknown[]
}

/**
 * Minimal chainable Supabase stub. `resolve(table, filters)` returns the row (or
 * null) a terminal maybeSingle()/single() should yield, letting each test decide
 * per-table behavior from the captured filters.
 */
function makeSupabase(
  resolve: (table: string, f: Captured) => unknown
): SupabaseClient {
  const from = (table: string) => {
    const f: Captured = { eq: {}, in: {}, contains: [] }
    const b: Record<string, unknown> = {}
    Object.assign(b, {
      select: () => b,
      eq: (col: string, val: unknown) => { f.eq[col] = val; return b },
      in: (col: string, vals: unknown[]) => { f.in[col] = vals; return b },
      contains: (_col: string, val: unknown) => { f.contains.push(val); return b },
      limit: () => b,
      maybeSingle: () => Promise.resolve({ data: resolve(table, f) }),
      single: () => Promise.resolve({ data: resolve(table, f) }),
    })
    return b
  }
  return { from } as unknown as SupabaseClient
}

describe('getPatientInboundState', () => {
  it('returns not-a-patient when no phone/email hash is supplied', async () => {
    const supabase = makeSupabase(() => { throw new Error('should not query') })
    const state = await getPatientInboundState(supabase, 'org-1', { phoneHashes: [] })
    expect(state).toEqual({ patientId: null, isPatient: false, inActiveTreatment: false, matchMethod: null })
  })

  it('returns not-a-patient when the phone hash matches no synced patient', async () => {
    const supabase = makeSupabase((table) => (table === 'patients' ? null : null))
    const state = await getPatientInboundState(supabase, 'org-1', { phoneHashes: ['h1'] })
    expect(state.isPatient).toBe(false)
    expect(state.inActiveTreatment).toBe(false)
  })

  it('flags inActiveTreatment when the matched patient has an accepted/completed procedure', async () => {
    const supabase = makeSupabase((table, f) => {
      if (table === 'patients') {
        // Matched by phone hash, not email.
        expect(f.in['phone_hash']).toEqual(['h1', 'h2'])
        return { id: 'pat-1' }
      }
      if (table === 'treatment_procedures') {
        // Only accepted(3)/completed(8) count as active treatment.
        expect(f.in['status_id']).toEqual([3, 8])
        expect(f.eq['patient_id']).toBe('pat-1')
        return { id: 'proc-1' }
      }
      return null
    })
    const state = await getPatientInboundState(supabase, 'org-1', { phoneHashes: ['h1', 'h2', 'h1'] })
    expect(state).toEqual({
      patientId: 'pat-1',
      isPatient: true,
      inActiveTreatment: true,
      matchMethod: 'phone_hash',
    })
  })

  it('is a patient but NOT in active treatment when only a proposed/consult procedure exists', async () => {
    const supabase = makeSupabase((table) => {
      if (table === 'patients') return { id: 'pat-2' }
      // No accepted/completed procedure → the status_id IN (3,8) query returns null.
      if (table === 'treatment_procedures') return null
      return null
    })
    const state = await getPatientInboundState(supabase, 'org-1', { phoneHashes: ['h9'] })
    expect(state.isPatient).toBe(true)
    expect(state.inActiveTreatment).toBe(false)
    expect(state.patientId).toBe('pat-2')
  })

  it('prefers an email-hash match over phone (higher confidence)', async () => {
    const supabase = makeSupabase((table, f) => {
      if (table === 'patients') {
        // The email branch runs first; it should match before the phone query.
        if (f.eq['email_hash'] === 'e1') return { id: 'pat-e' }
        return null
      }
      if (table === 'treatment_procedures') return { id: 'proc-e' }
      return null
    })
    const state = await getPatientInboundState(supabase, 'org-1', { phoneHashes: ['h1'], emailHash: 'e1' })
    expect(state.matchMethod).toBe('email_hash')
    expect(state.patientId).toBe('pat-e')
  })
})
