import { describe, it, expect, vi } from 'vitest'
import {
  setPendingReplyIntent,
  consumePendingReplyIntent,
  clearPendingReplyIntent,
} from '@/lib/messaging/pending-intent'

/**
 * A tiny chainable stub of the PostgREST query builder — enough to capture what
 * the helper writes/reads without a real Supabase. Each `.from()` returns a fresh
 * builder whose terminal call resolves to `terminal`.
 */
function fakeSupabase(opts: {
  onUpsert?: (row: any, config: any) => void
  selectRow?: any | null
  onDelete?: (filters: Record<string, any>) => void
}) {
  return {
    from(_table: string) {
      const deleteFilters: Record<string, any> = {}
      const builder: any = {
        upsert(row: any, config: any) {
          opts.onUpsert?.(row, config)
          return Promise.resolve({ data: null, error: null })
        },
        // read chain: select().eq().eq().gt().limit().maybeSingle()
        select() { return builder },
        eq(col: string, val: any) { deleteFilters[col] = val; return builder },
        gt() { return builder },
        limit() { return builder },
        maybeSingle() { return Promise.resolve({ data: opts.selectRow ?? null, error: null }) },
        // delete chain: delete().eq()  (returns a thenable so `await` resolves)
        delete() {
          const d: any = {
            eq(col: string, val: any) { deleteFilters[col] = val; return d },
            then(res: any) { opts.onDelete?.(deleteFilters); res({ data: null, error: null }) },
          }
          return d
        },
      }
      return builder
    },
  } as any
}

describe('pending SMS reply intent', () => {
  it('stamps the soliciting intent with a ref and 72h expiry, keyed on lead+channel', async () => {
    const onUpsert = vi.fn()
    const supabase = fakeSupabase({ onUpsert })

    await setPendingReplyIntent(supabase, {
      organizationId: 'org1',
      leadId: 'lead1',
      intent: 'appointment_confirm',
      refType: 'appointment',
      refId: 'apt1',
    })

    expect(onUpsert).toHaveBeenCalledTimes(1)
    const [row, config] = onUpsert.mock.calls[0]
    expect(row).toMatchObject({
      organization_id: 'org1',
      lead_id: 'lead1',
      channel: 'sms',
      intent: 'appointment_confirm',
      ref_type: 'appointment',
      ref_id: 'apt1',
    })
    // Freshest solicitation must overwrite the prior one, not stack.
    expect(config).toEqual({ onConflict: 'lead_id,channel' })
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now())
  })

  it('consume returns the live intent and deletes it so a later YES cannot re-fire it', async () => {
    const onDelete = vi.fn()
    const supabase = fakeSupabase({
      selectRow: { id: 'row1', intent: 'financing_followup', ref_type: 'financing_application', ref_id: null },
      onDelete,
    })

    const intent = await consumePendingReplyIntent(supabase, 'lead1', 'sms')

    expect(intent).toEqual({
      intent: 'financing_followup',
      ref_type: 'financing_application',
      ref_id: null,
    })
    // The marker is consumed (deleted by id) — the core fix against a stale YES.
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'row1' }))
  })

  it('consume returns null when nothing is pending (YES should fall through to AI)', async () => {
    const supabase = fakeSupabase({ selectRow: null })
    const intent = await consumePendingReplyIntent(supabase, 'lead1', 'sms')
    expect(intent).toBeNull()
  })

  it('clear removes any live intent for the lead/channel', async () => {
    const onDelete = vi.fn()
    const supabase = fakeSupabase({ onDelete })
    await clearPendingReplyIntent(supabase, 'lead1', 'sms')
    expect(onDelete).toHaveBeenCalledWith(
      expect.objectContaining({ lead_id: 'lead1', channel: 'sms' })
    )
  })
})
