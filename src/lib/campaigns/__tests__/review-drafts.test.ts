import { describe, it, expect, vi } from 'vitest'
import {
  enqueueCampaignReviewDraft,
  rejectCampaignReviewDraft,
  approveCampaignReviewDraft,
} from '@/lib/campaigns/review-drafts'

/**
 * Mock the campaign_review_drafts table only. `claimRow` is what the guarded
 * pending→(approved|rejected) update resolves to via .maybeSingle(): a row when
 * the claim wins, null when it was already reviewed (the idempotency guard).
 */
function mockSupabase(opts: {
  insertRow?: { id: string } | null
  claimRow?: any
}) {
  return {
    from: vi.fn((table: string) => {
      if (table === 'campaign_review_drafts') {
        return {
          insert: vi.fn().mockReturnThis(),
          update: vi.fn().mockReturnThis(),
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: opts.insertRow ?? null,
            error: opts.insertRow ? null : { message: 'insert failed' },
          }),
          maybeSingle: vi.fn().mockResolvedValue({
            data: opts.claimRow ?? null,
            error: null,
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    }),
  } as any
}

describe('enqueueCampaignReviewDraft', () => {
  it('returns the new draft id on success', async () => {
    const id = await enqueueCampaignReviewDraft(mockSupabase({ insertRow: { id: 'draft-1' } }), {
      organizationId: 'org-1', campaignId: 'c1', leadId: 'l1', conversationId: null, channel: 'sms', subject: null, body: 'hi',
    })
    expect(id).toBe('draft-1')
  })

  it('returns null (non-throwing) when the insert fails', async () => {
    const id = await enqueueCampaignReviewDraft(mockSupabase({ insertRow: null }), {
      organizationId: 'org-1', campaignId: 'c1', leadId: 'l1', conversationId: null, channel: 'email', subject: 's', body: 'hi',
    })
    expect(id).toBeNull()
  })
})

describe('review decision idempotency', () => {
  it('reject succeeds when the guarded claim wins', async () => {
    const res = await rejectCampaignReviewDraft(mockSupabase({ claimRow: { id: 'draft-1' } }), 'org-1', 'draft-1', 'user-1')
    expect(res).toEqual({ ok: true, status: 'rejected', sent_via: null })
  })

  it('reject is a no-op when the draft was already reviewed (claim returns null)', async () => {
    const res = await rejectCampaignReviewDraft(mockSupabase({ claimRow: null }), 'org-1', 'draft-1', 'user-1')
    expect(res.ok).toBe(false)
  })

  it('approve fails cleanly when the draft is already reviewed — nothing is sent', async () => {
    // claimRow null → the pending→approved claim lost the race; approve must NOT
    // fall through to a send. (No leads-table branch is even reached.)
    const res = await approveCampaignReviewDraft(mockSupabase({ claimRow: null }), 'org-1', 'draft-1', 'user-1')
    expect(res.ok).toBe(false)
    expect(res.sent_via).toBeUndefined()
  })
})
