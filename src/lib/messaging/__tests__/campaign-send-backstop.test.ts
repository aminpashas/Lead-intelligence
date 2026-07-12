import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/campaigns/send-authorization', () => ({
  assertCampaignSendAllowed: vi.fn(),
}))

import { assertCampaignSendAllowed } from '@/lib/campaigns/send-authorization'
import { sendSMSToLead } from '@/lib/messaging/twilio'

describe('sendSMSToLead campaign backstop', () => {
  beforeEach(() => vi.clearAllMocks())

  it('refuses an automation send the campaign layer blocks', async () => {
    ;(assertCampaignSendAllowed as any).mockResolvedValue({ allowed: false, reason: 'send_suppressed' })
    const res = await sendSMSToLead({
      supabase: {} as any, leadId: 'l1', to: '+15550000000', body: 'hi', caller: 'campaign.executor',
    })
    expect(res).toEqual({ sent: false, reason: 'campaign_not_authorized' })
  })
})
