import { describe, it, expect, vi } from 'vitest'
import { isAutomationCaller, assertCampaignSendAllowed } from '@/lib/campaigns/send-authorization'

function mockSupabase(leadOrg: string | null, enrollmentRows: any[]) {
  return {
    from: vi.fn((table: string) => {
      if (table === 'leads') {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: leadOrg ? { organization_id: leadOrg } : null, error: null }) }
      }
      // campaign_enrollments
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue({ data: enrollmentRows, error: null }) }
    }),
  } as any
}

describe('isAutomationCaller', () => {
  it('flags autopilot/campaign callers, exempts humans', () => {
    expect(isAutomationCaller('autopilot.auto_respond')).toBe(true)
    expect(isAutomationCaller('campaign.executor')).toBe(true)
    expect(isAutomationCaller('manual')).toBe(false)
    expect(isAutomationCaller(undefined)).toBe(false)
  })
})

describe('assertCampaignSendAllowed', () => {
  it('always allows human-initiated sends (no caller)', async () => {
    const res = await assertCampaignSendAllowed(mockSupabase('org-1', []), { leadId: 'l1' })
    expect(res).toEqual({ allowed: true })
  })

  it('blocks an automation send when the lead is in no active campaign', async () => {
    const res = await assertCampaignSendAllowed(mockSupabase('org-1', []), { leadId: 'l1', caller: 'campaign.executor' })
    expect(res).toEqual({ allowed: false, reason: 'no_active_campaign' })
  })

  it('blocks an automation send when the active campaign is suppressed', async () => {
    const rows = [{ campaign_id: 'c1', created_at: 't', campaign: { id: 'c1', ai_enabled: true, autopilot_mode: 'auto', send_mode: 'suppressed', playbook: {} } }]
    const res = await assertCampaignSendAllowed(mockSupabase('org-1', rows), { leadId: 'l1', caller: 'autopilot.speed_to_lead' })
    expect(res).toEqual({ allowed: false, reason: 'send_suppressed' })
  })

  it('allows an automation send when the active campaign is live', async () => {
    const rows = [{ campaign_id: 'c1', created_at: 't', campaign: { id: 'c1', ai_enabled: true, autopilot_mode: 'auto', send_mode: 'live', playbook: {} } }]
    const res = await assertCampaignSendAllowed(mockSupabase('org-1', rows), { leadId: 'l1', caller: 'campaign.nurture' })
    expect(res).toEqual({ allowed: true })
  })
})
