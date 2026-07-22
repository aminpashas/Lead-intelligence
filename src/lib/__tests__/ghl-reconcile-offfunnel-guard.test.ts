import { describe, it, expect } from 'vitest'
import { unparksOffFunnel } from '@/lib/ghl/reconcile'

/**
 * Regression pin for the off-funnel parking guard.
 *
 * The off-funnel sweep parks existing patients on EHR evidence (a CareStack
 * visit predating the enquiry) that GHL knows nothing about. GHL's reconcile is
 * otherwise stage-authoritative, and 105 of the 426 parked leads carry a GHL
 * opportunity — so without this guard the nightly reconcile un-parks them and
 * the hourly sweep re-parks them, forever.
 */
describe('unparksOffFunnel', () => {
  it('blocks a GHL stage write for a lead parked off-funnel', () => {
    expect(unparksOffFunnel('existing-patient')).toBe(true)
    expect(unparksOffFunnel('junk')).toBe(true)
  })

  it('leaves normal funnel stages fully GHL-authoritative', () => {
    for (const slug of [
      'new',
      'contacted',
      'qualified',
      'consultation-scheduled',
      'consultation-completed',
      'treatment-presented',
      'nurturing',
      'no-communication',
      'lost',
      'completed',
    ]) {
      expect(unparksOffFunnel(slug)).toBe(false)
    }
  })

  it('treats an unknown or absent current stage as unguarded', () => {
    // A lead whose stage_id is null or maps to no known slug must not be
    // silently frozen — the guard only ever protects the parking stages.
    expect(unparksOffFunnel(null)).toBe(false)
    expect(unparksOffFunnel(undefined)).toBe(false)
    expect(unparksOffFunnel('')).toBe(false)
    expect(unparksOffFunnel('some-custom-org-stage')).toBe(false)
  })
})
