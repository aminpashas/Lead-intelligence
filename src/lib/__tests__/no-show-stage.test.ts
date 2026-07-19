import { describe, it, expect } from 'vitest'
import { shouldMoveToNoShow, NO_SHOW_STAGE_SLUG } from '@/lib/pipeline/no-show-stage'
import { shouldAdvanceToConsult } from '@/lib/pipeline/booking-stage'
import { OPERATIONAL_STAGE_SLUGS, isOperationalStage } from '@/lib/pipeline/stage-groups'

// Convenience builder so each test states only the fields it cares about.
function guard(over: Partial<Parameters<typeof shouldMoveToNoShow>[0]>) {
  return shouldMoveToNoShow({ currentSlug: null, isWon: false, isLost: false, ...over })
}

describe('shouldMoveToNoShow', () => {
  describe('moves pre-close leads into the No-Show queue', () => {
    for (const slug of ['new', 'contacted', 'engaged', 'qualified', 'consultation-scheduled']) {
      it(`moves from ${slug}`, () => {
        expect(guard({ currentSlug: slug })).toBe(true)
      })
    }
    it('moves a lead with no stage yet', () => {
      expect(guard({ currentSlug: null })).toBe(true)
    })
  })

  describe('never drags a post-close patient back onto the sales board', () => {
    // Signed patients heading to surgery belong to the fulfillment funnel; a
    // missed visit there is Dion Clinical's scheduling problem, not a sales one.
    for (const slug of ['contract-signed', 'scheduled', 'completed']) {
      it(`is a no-op from ${slug}`, () => {
        expect(guard({ currentSlug: slug })).toBe(false)
      })
    }
  })

  describe('leaves deep-funnel leads with a rep actively on them', () => {
    // The queue surfaces leads NOBODY is working. A patient in Treatment
    // Presented / Financing has a rep mid-negotiation — often a live lender
    // application. Because enrollment rides this same guard, they are neither
    // moved nor sent the generic "want to grab another time?" recovery text.
    for (const slug of ['treatment-presented', 'financing']) {
      it(`is a no-op from ${slug}`, () => {
        expect(guard({ currentSlug: slug })).toBe(false)
      })
    }
  })

  describe('leaves off-funnel parking stages alone', () => {
    for (const slug of ['existing-patient', 'junk']) {
      it(`is a no-op from ${slug}`, () => {
        expect(guard({ currentSlug: slug })).toBe(false)
      })
    }
  })

  describe('respects won/lost flags regardless of slug', () => {
    it('does not move a won lead', () => {
      expect(guard({ currentSlug: 'consultation-scheduled', isWon: true })).toBe(false)
    })
    it('does not move a lost lead', () => {
      expect(guard({ currentSlug: 'consultation-scheduled', isLost: true })).toBe(false)
    })
  })

  it('is idempotent — a repeat no-show does not re-move an already-parked lead', () => {
    expect(guard({ currentSlug: NO_SHOW_STAGE_SLUG })).toBe(false)
  })
})

describe('no-show ↔ rebook round trip', () => {
  // Load-bearing: the whole point of the No-Show queue is that leads LEAVE it
  // when they rebook. booking-stage's guard has no 'no-show' entry in either of
  // its block-lists, so this works — but it works by omission, and a future edit
  // to AT_OR_PAST_CONSULT could silently strand every recovered no-show in the
  // queue forever. This test makes that regression loud.
  it('a rebooking pulls a lead back out of No-Show to Consultation Scheduled', () => {
    expect(
      shouldAdvanceToConsult({ currentSlug: NO_SHOW_STAGE_SLUG, isWon: false, isLost: false })
    ).toBe(true)
  })
})

describe('No-Show is an operational column', () => {
  // Operational stages count their TRUE population (no `status NOT IN
  // (disqualified, lost)` filter). A triage queue that hides rows because of a
  // sales-status filter is the same bug that once hid 8k leads from
  // "No Communication" — see stage-groups.ts.
  it('is registered in OPERATIONAL_STAGE_SLUGS', () => {
    expect(OPERATIONAL_STAGE_SLUGS).toContain(NO_SHOW_STAGE_SLUG)
  })
  it('is reported as operational by isOperationalStage', () => {
    expect(isOperationalStage(NO_SHOW_STAGE_SLUG)).toBe(true)
  })
})
