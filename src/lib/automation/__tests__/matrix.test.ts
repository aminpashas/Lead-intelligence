import { describe, it, expect } from 'vitest'
import {
  deriveOwnerCell,
  deriveVoiceOwner,
  buildRegistryRows,
  formatDuration,
  formatPercent,
  formatMoney,
  formatCountdown,
  WORK_KINDS,
} from '@/lib/automation/matrix'
import type { AllocationContext, AllocationOrgConfig } from '@/lib/automation/allocation'
import type { AutomationPolicy } from '@/types/database'
import type { WeekSchedule } from '@/lib/autopilot/config'

const ORG_ID = 'org-1'
const CAMPAIGN_ID = 'campaign-1'

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

/** Every-day human schedule so hybrid tests don't depend on the weekday. */
const allWeek = (start: number, end: number): WeekSchedule => {
  const on = { enabled: true, start, end }
  return {
    sunday: on,
    monday: on,
    tuesday: on,
    wednesday: on,
    thursday: on,
    friday: on,
    saturday: on,
  }
}

describe('deriveOwnerCell', () => {
  it('shows the legacy default when nothing is configured', () => {
    const cell = deriveOwnerCell([], orgConfig(), ctx())
    expect(cell.owner).toBe('ai')
    expect(cell.effectiveNow).toBe('ai')
    expect(cell.source).toBe('Default (AI)')
    expect(cell.policyId).toBeNull()
  })

  it('shows the org human-first window for inbound replies', () => {
    const cell = deriveOwnerCell(
      [],
      orgConfig({ human_first_sla_enabled: true, human_first_sla_seconds: 240 }),
      ctx({ kind: 'inbound_reply' })
    )
    expect(cell.owner).toBe('hold')
    expect(cell.effectiveNow).toBe('hold')
    expect(cell.source).toBe('Org human-first window')
    expect(cell.slaSeconds).toBe(240)
  })

  it('the org toggle does not leak into other kinds', () => {
    const cell = deriveOwnerCell(
      [],
      orgConfig({ human_first_sla_enabled: true }),
      ctx({ kind: 'nurture_step' })
    )
    expect(cell.owner).toBe('ai')
    expect(cell.source).toBe('Default (AI)')
  })

  it('maps a campaign policy to its scope label', () => {
    const p = policy({ scope: 'campaign', campaign_id: CAMPAIGN_ID, owner: 'human' })
    const cell = deriveOwnerCell([p], orgConfig(), ctx({ campaignId: CAMPAIGN_ID }))
    expect(cell.owner).toBe('human')
    expect(cell.effectiveNow).toBe('human')
    expect(cell.source).toBe('Campaign policy')
    expect(cell.policyId).toBe(p.id)
  })

  it('human_first shows configured owner "hold" regardless of the owner column', () => {
    const p = policy({ owner: 'ai', human_first: true, human_response_sla_seconds: 300 })
    const cell = deriveOwnerCell([p], orgConfig(), ctx())
    expect(cell.owner).toBe('hold')
    expect(cell.effectiveNow).toBe('hold')
    expect(cell.slaSeconds).toBe(300)
    expect(cell.source).toBe('Org policy')
  })

  it('hybrid keeps configured owner "hybrid" while effectiveNow resolves through the schedule', () => {
    const p = policy({
      owner: 'hybrid',
      human_schedule: allWeek(0, 24) as unknown as Record<string, unknown>,
    })
    const inHumanHours = deriveOwnerCell([p], orgConfig(), ctx())
    expect(inHumanHours.owner).toBe('hybrid')
    expect(inHumanHours.effectiveNow).toBe('human')

    // Hybrid with no schedule = AI hours everywhere.
    const noSchedule = deriveOwnerCell([policy({ owner: 'hybrid' })], orgConfig(), ctx())
    expect(noSchedule.owner).toBe('hybrid')
    expect(noSchedule.effectiveNow).toBe('ai')
  })

  it('covers every work kind without throwing', () => {
    for (const { kind } of WORK_KINDS) {
      expect(deriveOwnerCell([], orgConfig(), ctx({ kind })).owner).toBe('ai')
    }
  })
})

describe('deriveVoiceOwner', () => {
  it('is AI-only without live transfer', () => {
    const v = deriveVoiceOwner({
      agent_type: 'setter',
      live_transfer_enabled: false,
      transfer_mode: 'immediate',
    })
    expect(v.owner).toBe('ai')
    expect(v.label).toContain('setter')
  })

  it('is hybrid with live transfer, describing the mode', () => {
    const v = deriveVoiceOwner({
      agent_type: 'closer',
      live_transfer_enabled: true,
      transfer_mode: 'qualify_transfer',
    })
    expect(v.owner).toBe('hybrid')
    expect(v.label).toContain('qualifies')
  })
})

describe('buildRegistryRows', () => {
  const NOW = new Date('2026-07-11T12:00:00Z')

  it('marks never-run, ok, stale and failing crons', () => {
    const rows = buildRegistryRows(
      { 'sla-takeover': 10, 'ghl-sync': 40, 'brex-sync': 26 * 60, 'carestack-sync': 26 * 60 },
      {
        'sla-takeover': {
          status: 'ok',
          ran_at: '2026-07-11T11:59:00Z',
          error: null,
          items_processed: 3,
        },
        'ghl-sync': {
          status: 'ok',
          ran_at: '2026-07-11T10:00:00Z', // 120 min ago > 40 min window
          error: null,
          items_processed: 0,
        },
        'brex-sync': {
          status: 'failed',
          ran_at: '2026-07-11T06:00:00Z',
          error: 'boom',
          items_processed: 0,
        },
      },
      NOW
    )
    const byName = Object.fromEntries(rows.map((r) => [r.cron, r]))
    expect(byName['sla-takeover'].health).toBe('ok')
    expect(byName['ghl-sync'].health).toBe('stale')
    expect(byName['brex-sync'].health).toBe('failing')
    expect(byName['brex-sync'].lastError).toBe('boom')
    expect(byName['carestack-sync'].health).toBe('never_ran')
    // Schedules resolve from the static map.
    expect(byName['sla-takeover'].schedule).toBe('Every minute')
  })
})

describe('formatting', () => {
  it('formatDuration', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(45)).toBe('45s')
    expect(formatDuration(95)).toBe('1m 35s')
    expect(formatDuration(120)).toBe('2m')
    expect(formatDuration(3720)).toBe('1h 2m')
  })

  it('formatPercent', () => {
    expect(formatPercent(null)).toBe('—')
    expect(formatPercent(0.8234)).toBe('82%')
    expect(formatPercent(0)).toBe('0%')
  })

  it('formatMoney', () => {
    expect(formatMoney(null)).toBe('—')
    expect(formatMoney(950)).toBe('$950')
    expect(formatMoney(12345.6)).toBe('$12.3k')
    expect(formatMoney(2_500_000)).toBe('$2.5M')
  })

  it('formatCountdown', () => {
    expect(formatCountdown(95_000)).toBe('1:35')
    expect(formatCountdown(-5)).toBe('0:00')
    expect(formatCountdown(60_000)).toBe('1:00')
  })
})
