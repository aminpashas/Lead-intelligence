import { describe, it, expect } from 'vitest'
import {
  resolveAllocation,
  type AllocationContext,
  type AllocationOrgConfig,
} from '@/lib/automation/allocation'
import type { AutomationPolicy } from '@/types/database'
import type { WeekSchedule } from '@/lib/autopilot/config'

const ORG_ID = 'org-1'
const CAMPAIGN_ID = 'campaign-1'
const STAGE_ID = 'stage-1'
const SMART_LIST_ID = 'list-1'

const orgConfig = (overrides: Partial<AllocationOrgConfig> = {}): AllocationOrgConfig => ({
  timezone: 'America/New_York',
  human_first_sla_enabled: false,
  human_first_sla_seconds: 180,
  ...overrides,
})

const ctx = (overrides: Partial<AllocationContext> = {}): AllocationContext => ({
  organizationId: ORG_ID,
  kind: 'inbound_reply',
  ...overrides,
})

let policyCounter = 0
const policy = (overrides: Partial<AutomationPolicy> = {}): AutomationPolicy => ({
  id: `policy-${++policyCounter}`,
  organization_id: ORG_ID,
  scope: 'org_default',
  campaign_id: null,
  voice_campaign_id: null,
  stage_id: null,
  smart_list_id: null,
  kinds: [],
  owner: 'ai',
  ai_role: null,
  human_schedule: null,
  human_first: false,
  human_response_sla_seconds: 180,
  enabled: true,
  created_at: '2026-07-11T00:00:00Z',
  updated_at: '2026-07-11T00:00:00Z',
  ...overrides,
})

/** Weekday-only (Mon–Fri) human schedule, 9–17. */
const weekdaySchedule = (start = 9, end = 17): WeekSchedule => {
  const on = { enabled: true, start, end }
  const off = { enabled: false, start, end }
  return {
    sunday: off,
    monday: on,
    tuesday: on,
    wednesday: on,
    thursday: on,
    friday: on,
    saturday: off,
  }
}

describe('resolveAllocation — dormant defaults', () => {
  it('returns legacy default (ai) with zero policy rows and org toggle off', () => {
    const decision = resolveAllocation([], orgConfig(), ctx())
    expect(decision).toEqual({
      owner: 'ai',
      reason: 'legacy_default',
      policyId: null,
      slaSeconds: null,
      aiRole: null,
    })
  })

  it('returns legacy default for every kind when nothing is configured', () => {
    for (const kind of ['inbound_reply', 'speed_to_lead', 'nurture_step', 'stage_automation', 'recommendation'] as const) {
      expect(resolveAllocation([], orgConfig(), ctx({ kind })).reason).toBe('legacy_default')
    }
  })
})

describe('resolveAllocation — org-level human-first SLA', () => {
  it('holds inbound_reply with 180s when org toggle is on and no policy matches', () => {
    const decision = resolveAllocation([], orgConfig({ human_first_sla_enabled: true }), ctx())
    expect(decision.owner).toBe('hold')
    expect(decision.reason).toBe('org_human_first_sla')
    expect(decision.slaSeconds).toBe(180)
    expect(decision.policyId).toBeNull()
  })

  it('uses the org-configured SLA seconds', () => {
    const decision = resolveAllocation(
      [],
      orgConfig({ human_first_sla_enabled: true, human_first_sla_seconds: 600 }),
      ctx()
    )
    expect(decision.slaSeconds).toBe(600)
  })

  it('does NOT apply the org toggle to non-inbound kinds', () => {
    const decision = resolveAllocation(
      [],
      orgConfig({ human_first_sla_enabled: true }),
      ctx({ kind: 'speed_to_lead' })
    )
    expect(decision).toMatchObject({ owner: 'ai', reason: 'legacy_default' })
  })

  it('a matching policy row wins over the org toggle', () => {
    const decision = resolveAllocation(
      [policy({ owner: 'ai' })],
      orgConfig({ human_first_sla_enabled: true }),
      ctx()
    )
    expect(decision).toMatchObject({ owner: 'ai', reason: 'policy_ai' })
  })
})

describe('resolveAllocation — precedence', () => {
  it('campaign beats stage, segment, and org_default', () => {
    const campaignPolicy = policy({ scope: 'campaign', campaign_id: CAMPAIGN_ID, owner: 'human' })
    const policies = [
      policy({ scope: 'org_default', owner: 'ai' }),
      policy({ scope: 'segment', smart_list_id: SMART_LIST_ID, owner: 'ai' }),
      policy({ scope: 'stage', stage_id: STAGE_ID, owner: 'ai' }),
      campaignPolicy,
    ]
    const decision = resolveAllocation(
      policies,
      orgConfig(),
      ctx({ campaignId: CAMPAIGN_ID, stageId: STAGE_ID, smartListId: SMART_LIST_ID })
    )
    expect(decision.owner).toBe('human')
    expect(decision.policyId).toBe(campaignPolicy.id)
  })

  it('stage beats segment and org_default when no campaign policy matches', () => {
    const stagePolicy = policy({ scope: 'stage', stage_id: STAGE_ID, owner: 'human' })
    const policies = [
      policy({ scope: 'org_default', owner: 'ai' }),
      policy({ scope: 'segment', smart_list_id: SMART_LIST_ID, owner: 'ai' }),
      stagePolicy,
    ]
    const decision = resolveAllocation(
      policies,
      orgConfig(),
      ctx({ stageId: STAGE_ID, smartListId: SMART_LIST_ID })
    )
    expect(decision.owner).toBe('human')
    expect(decision.policyId).toBe(stagePolicy.id)
  })

  it('segment beats org_default', () => {
    const segmentPolicy = policy({ scope: 'segment', smart_list_id: SMART_LIST_ID, owner: 'human' })
    const policies = [policy({ scope: 'org_default', owner: 'ai' }), segmentPolicy]
    const decision = resolveAllocation(policies, orgConfig(), ctx({ smartListId: SMART_LIST_ID }))
    expect(decision.owner).toBe('human')
    expect(decision.policyId).toBe(segmentPolicy.id)
  })

  it('falls back to org_default when no specific target matches', () => {
    const orgPolicy = policy({ scope: 'org_default', owner: 'human' })
    const policies = [
      policy({ scope: 'campaign', campaign_id: 'other-campaign', owner: 'ai' }),
      orgPolicy,
    ]
    const decision = resolveAllocation(policies, orgConfig(), ctx({ campaignId: CAMPAIGN_ID }))
    expect(decision.policyId).toBe(orgPolicy.id)
  })

  it('matches a campaign policy via voice_campaign_id', () => {
    const voicePolicy = policy({ scope: 'campaign', voice_campaign_id: 'vc-1', owner: 'human' })
    const decision = resolveAllocation([voicePolicy], orgConfig(), ctx({ voiceCampaignId: 'vc-1' }))
    expect(decision).toMatchObject({ owner: 'human', policyId: voicePolicy.id })
  })
})

describe('resolveAllocation — kinds filtering', () => {
  it('empty kinds array applies to all kinds', () => {
    const p = policy({ owner: 'human', kinds: [] })
    expect(resolveAllocation([p], orgConfig(), ctx({ kind: 'nurture_step' })).owner).toBe('human')
    expect(resolveAllocation([p], orgConfig(), ctx({ kind: 'inbound_reply' })).owner).toBe('human')
  })

  it('policy with specific kinds only matches those kinds', () => {
    const p = policy({ owner: 'human', kinds: ['speed_to_lead'] })
    expect(resolveAllocation([p], orgConfig(), ctx({ kind: 'speed_to_lead' })).owner).toBe('human')
    expect(resolveAllocation([p], orgConfig(), ctx({ kind: 'inbound_reply' }))).toMatchObject({
      owner: 'ai',
      reason: 'legacy_default',
    })
  })

  it('a kind-mismatched specific policy lets a broader policy win', () => {
    const campaignPolicy = policy({
      scope: 'campaign',
      campaign_id: CAMPAIGN_ID,
      owner: 'human',
      kinds: ['inbound_reply'],
    })
    const orgPolicy = policy({ scope: 'org_default', owner: 'ai', kinds: [] })
    const decision = resolveAllocation(
      [campaignPolicy, orgPolicy],
      orgConfig(),
      ctx({ kind: 'nurture_step', campaignId: CAMPAIGN_ID })
    )
    expect(decision.policyId).toBe(orgPolicy.id)
  })
})

describe('resolveAllocation — disabled policies', () => {
  it('skips disabled policies entirely', () => {
    const decision = resolveAllocation([policy({ owner: 'human', enabled: false })], orgConfig(), ctx())
    expect(decision).toMatchObject({ owner: 'ai', reason: 'legacy_default' })
  })

  it('a disabled specific policy falls through to the org_default', () => {
    const orgPolicy = policy({ scope: 'org_default', owner: 'ai' })
    const decision = resolveAllocation(
      [policy({ scope: 'campaign', campaign_id: CAMPAIGN_ID, owner: 'human', enabled: false }), orgPolicy],
      orgConfig(),
      ctx({ campaignId: CAMPAIGN_ID })
    )
    expect(decision.policyId).toBe(orgPolicy.id)
  })
})

describe('resolveAllocation — human_first', () => {
  it('human_first policy holds with its own SLA', () => {
    const p = policy({ owner: 'human', human_first: true, human_response_sla_seconds: 300 })
    const decision = resolveAllocation([p], orgConfig(), ctx())
    expect(decision.owner).toBe('hold')
    expect(decision.reason).toBe('policy_human_first')
    expect(decision.slaSeconds).toBe(300)
    expect(decision.policyId).toBe(p.id)
  })

  it('carries the policy ai_role through on hold decisions', () => {
    const p = policy({ owner: 'hybrid', human_first: true, ai_role: 'closer' })
    expect(resolveAllocation([p], orgConfig(), ctx()).aiRole).toBe('closer')
  })
})

describe('resolveAllocation — hybrid schedule boundaries (America/Los_Angeles 9–17)', () => {
  const laOrg = orgConfig({ timezone: 'America/Los_Angeles' })
  const hybrid = policy({
    owner: 'hybrid',
    human_schedule: weekdaySchedule(9, 17) as unknown as Record<string, unknown>,
    ai_role: 'setter',
  })

  // 2026-07-08 is a Wednesday; PDT is UTC-7.

  it('08:59 local → AI hours', () => {
    // 08:59 PDT = 15:59 UTC
    const decision = resolveAllocation([hybrid], laOrg, ctx({ now: new Date('2026-07-08T15:59:00Z') }))
    expect(decision).toMatchObject({ owner: 'ai', reason: 'hybrid_ai_hours', aiRole: 'setter' })
  })

  it('09:00 local (inclusive start) → human hours', () => {
    // 09:00 PDT = 16:00 UTC
    const decision = resolveAllocation([hybrid], laOrg, ctx({ now: new Date('2026-07-08T16:00:00Z') }))
    expect(decision).toMatchObject({ owner: 'human', reason: 'hybrid_human_hours' })
    expect(decision.slaSeconds).toBe(180)
  })

  it('16:59 local → human hours', () => {
    // 16:59 PDT = 23:59 UTC
    const decision = resolveAllocation([hybrid], laOrg, ctx({ now: new Date('2026-07-08T23:59:00Z') }))
    expect(decision.owner).toBe('human')
  })

  it('17:00 local (exclusive end) → AI hours', () => {
    // 17:00 PDT Wed = 00:00 UTC Thu
    const decision = resolveAllocation([hybrid], laOrg, ctx({ now: new Date('2026-07-09T00:00:00Z') }))
    expect(decision).toMatchObject({ owner: 'ai', reason: 'hybrid_ai_hours' })
  })

  it('weekend (Saturday, disabled day) → AI hours even at 11:00 local', () => {
    // 2026-07-11 is a Saturday; 11:00 PDT = 18:00 UTC
    const decision = resolveAllocation([hybrid], laOrg, ctx({ now: new Date('2026-07-11T18:00:00Z') }))
    expect(decision).toMatchObject({ owner: 'ai', reason: 'hybrid_ai_hours' })
  })

  it('same instant resolves differently in a different timezone', () => {
    // 16:00 UTC = 09:00 PDT (human) but 12:00 EDT — still human in NY (9–17).
    // 03:00 UTC Thu = 20:00 PDT Wed (AI) and 23:00 EDT Wed (AI).
    const nyOrg = orgConfig({ timezone: 'America/New_York' })
    const at = new Date('2026-07-08T13:30:00Z') // 06:30 PDT (AI) / 09:30 EDT (human)
    expect(resolveAllocation([hybrid], laOrg, ctx({ now: at })).owner).toBe('ai')
    expect(resolveAllocation([hybrid], nyOrg, ctx({ now: at })).owner).toBe('human')
  })

  it('hybrid with no schedule defaults to AI', () => {
    const p = policy({ owner: 'hybrid', human_schedule: null })
    const decision = resolveAllocation([p], laOrg, ctx({ now: new Date('2026-07-08T16:00:00Z') }))
    expect(decision).toMatchObject({ owner: 'ai', reason: 'hybrid_no_schedule' })
  })
})

describe('resolveAllocation — decision metadata', () => {
  it('owner=human carries the SLA and ai_role through', () => {
    const p = policy({ owner: 'human', human_response_sla_seconds: 240, ai_role: 'setter' })
    const decision = resolveAllocation([p], orgConfig(), ctx())
    expect(decision).toEqual({
      owner: 'human',
      reason: 'policy_human',
      policyId: p.id,
      slaSeconds: 240,
      aiRole: 'setter',
    })
  })

  it('owner=ai has no SLA', () => {
    const p = policy({ owner: 'ai' })
    const decision = resolveAllocation([p], orgConfig(), ctx())
    expect(decision).toEqual({
      owner: 'ai',
      reason: 'policy_ai',
      policyId: p.id,
      slaSeconds: null,
      aiRole: null,
    })
  })
})
