import { describe, it, expect, vi, beforeEach } from 'vitest'

// Pre-gate dependency #1: autopilot config + active-hours check.
// getAutopilotConfig must resolve enabled/not-paused/speed_to_lead-on/not-suppressed,
// and getLocalHourAndDay must land inside the (0-24) active window so the
// TCPA quiet-hours check never short-circuits before the campaign gate.
vi.mock('@/lib/autopilot/config', () => ({
  getAutopilotConfig: vi.fn().mockResolvedValue({
    enabled: true, paused: false, speed_to_lead: true, outreach_suppressed: false,
    timezone: 'America/Los_Angeles', active_hours_start: 0, active_hours_end: 24,
    confidence_threshold: 0.6,
  }),
  getLocalHourAndDay: vi.fn().mockReturnValue({ hour: 12, day: 3 }),
}))

// Pre-gate dependency #2: allocation policy gate. With zero policy rows this
// legacy-defaults to 'ai', but we mock it explicitly so the test doesn't
// depend on that default and to prove owner='ai' is what lets us reach the gate.
vi.mock('@/lib/automation/allocation', () => ({
  resolveAutomationOwner: vi.fn().mockResolvedValue({ owner: 'ai', reason: 'legacy_default' }),
}))

// Pre-gate dependency #3: setter-agent capacity check. getAgentIdForRole is
// called first; returning null means "no setter agent configured" and the
// capacity check (checkAgentCapacity) is skipped entirely (see the
// `if (setterAgentId) { ... }` guard in speed-to-lead.ts).
vi.mock('@/lib/agents/agent-resolver', () => ({
  getAgentIdForRole: vi.fn().mockResolvedValue(null),
}))

// The gate under test.
vi.mock('@/lib/campaigns/policy', () => ({ resolveActiveCampaignPolicy: vi.fn() }))

import { resolveActiveCampaignPolicy } from '@/lib/campaigns/policy'
import { triggerSpeedToLead } from '@/lib/autopilot/speed-to-lead'

function leadSupabase() {
  return {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          id: 'l1',
          phone_formatted: '+15550000000',
          sms_consent: true,
          sms_opt_out: false,
          is_existing_patient: false,
        },
        error: null,
      }),
    })),
  } as any
}

describe('speed-to-lead campaign gate', () => {
  beforeEach(() => vi.clearAllMocks())

  it('skips a new lead that is in no AI campaign', async () => {
    ;(resolveActiveCampaignPolicy as any).mockResolvedValue(null)
    const res = await triggerSpeedToLead(leadSupabase(), 'l1', 'org-1')
    expect(res.action).toBe('skipped')
    expect(res.reason).toBe('no_ai_campaign')
  })
})
