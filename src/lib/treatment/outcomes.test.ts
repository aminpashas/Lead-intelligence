import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { recordTreatmentOutcome } from './outcomes'

/**
 * Minimal Supabase mock. Captures the insert payload per table and lets the test
 * control the treatment_outcomes insert result. The lead_activities / events inserts
 * are awaited via `.then(cb)`, so insert() returns a thenable resolving { error }.
 */
function makeSupabase(outcomeResult: { data: { id: string } | null; error: { message: string } | null }) {
  const inserts: Record<string, Record<string, unknown>> = {}
  const client = {
    from(table: string) {
      return {
        insert(payload: Record<string, unknown>) {
          inserts[table] = payload
          if (table === 'treatment_outcomes') {
            return { select: () => ({ single: async () => outcomeResult }) }
          }
          return Promise.resolve({ error: null })
        },
      }
    },
  }
  return { client: client as unknown as SupabaseClient, inserts }
}

describe('recordTreatmentOutcome', () => {
  it('inserts the outcome, an activity trail, and an internal (na) event', async () => {
    const { client, inserts } = makeSupabase({ data: { id: 'out-1' }, error: null })

    const res = await recordTreatmentOutcome(client, {
      organizationId: 'org-1',
      leadId: 'lead-1',
      outcome: 'success',
      satisfactionScore: 9,
      finalRevenue: 24000,
      recordedBy: 'user-1',
    })

    expect(res).toEqual({ id: 'out-1' })

    // Outcome row
    expect(inserts.treatment_outcomes).toMatchObject({
      organization_id: 'org-1',
      lead_id: 'lead-1',
      outcome: 'success',
      satisfaction_score: 9,
      final_revenue: 24000,
      revision_required: false,
    })

    // Activity trail
    expect(inserts.lead_activities).toMatchObject({
      lead_id: 'lead-1',
      activity_type: 'treatment_outcome_recorded',
      title: 'Treatment outcome: success',
    })

    // Internal event — must NOT be forwarded to ad platforms
    expect(inserts.events).toMatchObject({
      event_type: 'treatment.outcome_recorded',
      capi_status: 'na',
      gads_status: 'na',
    })
  })

  it('throws when the outcome insert fails', async () => {
    const { client } = makeSupabase({ data: null, error: { message: 'boom' } })
    await expect(
      recordTreatmentOutcome(client, { organizationId: 'org-1', leadId: 'lead-1', outcome: 'failure' })
    ).rejects.toThrow(/boom/)
  })
})
