import { describe, it, expect } from 'vitest'
import {
  computeNoShowRisk,
  selectEscalationTier,
  isCheckinExpired,
  RISK_TIER1,
  RISK_TIER2,
  type NoShowRiskInput,
} from '@/lib/campaigns/attendance-risk'

const base: NoShowRiskInput = {
  confirmed: false,
  priorNoShows: 0,
  engagementScore: 50,
  remindersSent: 0,
  remindersFailed: 0,
  remindersUnanswered: 0,
  checkinExpiredUnanswered: false,
}

describe('computeNoShowRisk', () => {
  it('clean unconfirmed appointment = base 30', () => {
    expect(computeNoShowRisk(base)).toBe(30)
  })

  it('clean confirmed appointment = 5', () => {
    expect(computeNoShowRisk({ ...base, confirmed: true })).toBe(5)
  })

  it('confirmation does NOT erase history: confirmed + 2 prior no-shows = 45 (tier 1 band)', () => {
    expect(computeNoShowRisk({ ...base, confirmed: true, priorNoShows: 2 })).toBe(45)
  })

  it('prior no-shows cap at +40', () => {
    expect(computeNoShowRisk({ ...base, confirmed: true, priorNoShows: 5 })).toBe(45)
  })

  it('expired unanswered check-in adds +25 (confirmed serial no-shower hits tier 2)', () => {
    expect(
      computeNoShowRisk({ ...base, confirmed: true, priorNoShows: 2, checkinExpiredUnanswered: true })
    ).toBe(70)
  })

  it('unanswered reminders and failures raise unconfirmed risk', () => {
    expect(
      computeNoShowRisk({ ...base, remindersSent: 3, remindersUnanswered: 3, remindersFailed: 1 })
    ).toBe(65) // 30 + 20 (all unanswered) + 15 (failures)
  })

  it('low engagement adds +10', () => {
    expect(computeNoShowRisk({ ...base, engagementScore: 10 })).toBe(40)
    expect(computeNoShowRisk({ ...base, engagementScore: null })).toBe(30)
  })

  it('caps at 100', () => {
    expect(
      computeNoShowRisk({
        ...base,
        priorNoShows: 5,
        engagementScore: 0,
        remindersSent: 4,
        remindersUnanswered: 4,
        remindersFailed: 2,
        checkinExpiredUnanswered: true,
      })
    ).toBe(100)
  })
})

describe('selectEscalationTier boundaries', () => {
  it('39 → 0, 40 → 1, 69 → 1, 70 → 2', () => {
    expect(selectEscalationTier(RISK_TIER1 - 1)).toBe(0)
    expect(selectEscalationTier(RISK_TIER1)).toBe(1)
    expect(selectEscalationTier(RISK_TIER2 - 1)).toBe(1)
    expect(selectEscalationTier(RISK_TIER2)).toBe(2)
  })
})

describe('isCheckinExpired', () => {
  const now = new Date('2026-07-02T12:00:00Z')
  it('expired only after 2h of silence', () => {
    expect(isCheckinExpired('2026-07-02T09:00:00Z', null, now)).toBe(true)
    expect(isCheckinExpired('2026-07-02T11:00:00Z', null, now)).toBe(false)
  })
  it('a reply or no check-in means never expired', () => {
    expect(isCheckinExpired('2026-07-02T09:00:00Z', '2026-07-02T09:30:00Z', now)).toBe(false)
    expect(isCheckinExpired(null, null, now)).toBe(false)
  })
})
