import { describe, it, expect, vi } from 'vitest'
import { resolveActiveCampaignPolicy } from '@/lib/campaigns/policy'

function mockSupabase(rows: any[] | null, error: unknown = null) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: rows, error }),
  }
  return { from: vi.fn(() => chain) } as any
}

describe('resolveActiveCampaignPolicy', () => {
  it('returns null when the lead has no active enrollment', async () => {
    const policy = await resolveActiveCampaignPolicy(mockSupabase([]), 'lead-1', 'org-1')
    expect(policy).toBeNull()
  })

  it('returns the last-touch active campaign policy with defaults applied', async () => {
    const rows = [
      { campaign_id: 'c-2', created_at: '2026-07-10T00:00:00Z', campaign: { id: 'c-2', ai_enabled: true, autopilot_mode: 'auto', send_mode: 'live', playbook: { goal: 'rebook' } } },
    ]
    const policy = await resolveActiveCampaignPolicy(mockSupabase(rows), 'lead-1', 'org-1')
    expect(policy).toEqual({
      campaignId: 'c-2',
      aiEnabled: true,
      autopilotMode: 'auto',
      sendMode: 'live',
      playbook: { goal: 'rebook' },
    })
  })

  it('defaults missing policy fields to review_first / suppressed / {}', async () => {
    const rows = [{ campaign_id: 'c-3', created_at: '2026-07-10T00:00:00Z', campaign: { id: 'c-3', ai_enabled: false, autopilot_mode: null, send_mode: null, playbook: null } }]
    const policy = await resolveActiveCampaignPolicy(mockSupabase(rows), 'lead-1', 'org-1')
    expect(policy).toMatchObject({ aiEnabled: false, autopilotMode: 'review_first', sendMode: 'suppressed', playbook: {} })
  })
})
