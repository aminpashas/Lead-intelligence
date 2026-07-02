import { describe, it, expect } from 'vitest'
import {
  NO_SHOW_RECOVERY_STEPS,
  NO_SHOW_RECOVERY_EXIT_STATUSES,
} from '@/lib/campaigns/no-show-recovery'

describe('no-show recovery campaign shape', () => {
  it('is a 3-touch sequence: same-day SMS, day-3 SMS, day-10 email', () => {
    expect(NO_SHOW_RECOVERY_STEPS.map((s) => [s.step_number, s.channel, s.delay_minutes])).toEqual([
      [1, 'sms', 30],
      [2, 'sms', 3 * 1440 - 30],
      [3, 'email', 7 * 1440],
    ])
  })

  it('rebooking exits the campaign (consultation_scheduled is an exit status)', () => {
    expect(NO_SHOW_RECOVERY_EXIT_STATUSES).toContain('consultation_scheduled')
    expect(NO_SHOW_RECOVERY_EXIT_STATUSES).toContain('lost')
  })

  it('every step has fallback copy referencing the patient', () => {
    for (const s of NO_SHOW_RECOVERY_STEPS) {
      expect(s.body_template).toContain('{{first_name}}')
      expect(s.body_template.length).toBeGreaterThan(40)
    }
  })
})
