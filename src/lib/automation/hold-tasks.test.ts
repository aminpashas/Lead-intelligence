import { describe, it, expect } from 'vitest'
import { buildHoldTaskInput, decideFollowUpHold } from './hold-tasks'

describe('buildHoldTaskInput', () => {
  it('produces a callback task with due_at = hold date and the hold dedupe key', () => {
    const input = buildHoldTaskInput({
      organizationId: 'org1',
      leadId: 'lead1',
      leadName: 'Jane D.',
      holdUntil: '2026-08-03T16:00:00Z',
      reason: 'wants to talk to spouse',
      assignedTo: 'user1',
      assignedRole: 'office_manager',
      createdBy: 'user1',
    })
    expect(input.kind).toBe('callback')
    expect(input.due_at).toBe('2026-08-03T16:00:00Z')
    expect(input.dedupe_key).toBe('hold:lead1')
    expect(input.detail).toContain('spouse')
    expect(input.title).toContain('Jane D.')
    expect(input.source).toBe('lead_hold')
  })
})

describe('decideFollowUpHold', () => {
  const now = new Date('2026-07-23T12:00:00Z')
  const future = '2026-08-03T12:00:00Z'
  const past = '2026-07-01T12:00:00Z'

  it('holds a deliberating deal with a future follow-up date', () => {
    const d = decideFollowUpHold({
      newTemperature: 'deliberating',
      newFollowUpAt: future,
      oldHoldUntil: null,
      oldFollowUpAt: null,
      now,
    })
    expect(d).toEqual({ action: 'set', holdUntil: future })
  })

  it('does not hold when the follow-up date is in the past', () => {
    const d = decideFollowUpHold({
      newTemperature: 'deliberating',
      newFollowUpAt: past,
      oldHoldUntil: null,
      oldFollowUpAt: null,
      now,
    })
    expect(d.action).toBe('none')
  })

  it('does not hold a non-deliberating temperature even with a future date', () => {
    const d = decideFollowUpHold({
      newTemperature: 'warm',
      newFollowUpAt: future,
      oldHoldUntil: null,
      oldFollowUpAt: null,
      now,
    })
    expect(d.action).toBe('none')
  })

  it('clears the hold when a deliberating deal leaves deliberating', () => {
    // The prior hold was placed BY this flow: hold_until === the old follow-up date.
    const d = decideFollowUpHold({
      newTemperature: 'warm',
      newFollowUpAt: null,
      oldHoldUntil: future,
      oldFollowUpAt: future,
      now,
    })
    expect(d.action).toBe('clear')
  })

  it('clears the hold when the follow-up date is removed but the deal stays deliberating', () => {
    const d = decideFollowUpHold({
      newTemperature: 'deliberating',
      newFollowUpAt: null,
      oldHoldUntil: future,
      oldFollowUpAt: future,
      now,
    })
    expect(d.action).toBe('clear')
  })

  it('NEVER clears an unrelated manual hold (hold_until differs from the follow-up date)', () => {
    // A rep manually held the lead until Sep 1 for a different reason, and there
    // was no follow-up date. Editing the closing card must not wipe that hold.
    const d = decideFollowUpHold({
      newTemperature: 'warm',
      newFollowUpAt: null,
      oldHoldUntil: '2026-09-01T12:00:00Z',
      oldFollowUpAt: null,
      now,
    })
    expect(d.action).toBe('none')
  })

  it('setting a new future date takes priority over clearing (re-hold to the new date)', () => {
    const later = '2026-08-20T12:00:00Z'
    const d = decideFollowUpHold({
      newTemperature: 'deliberating',
      newFollowUpAt: later,
      oldHoldUntil: future,
      oldFollowUpAt: future,
      now,
    })
    expect(d).toEqual({ action: 'set', holdUntil: later })
  })

  it('defaults to pausing automation when the flag is omitted', () => {
    const d = decideFollowUpHold({
      newTemperature: 'deliberating',
      newFollowUpAt: future,
      oldHoldUntil: null,
      oldFollowUpAt: null,
      now,
    })
    expect(d.action).toBe('set')
  })

  it('places NO hold when the rep opts out of pausing automation', () => {
    const d = decideFollowUpHold({
      newTemperature: 'deliberating',
      newFollowUpAt: future,
      oldHoldUntil: null,
      oldFollowUpAt: null,
      pauseAutomation: false,
      now,
    })
    expect(d.action).toBe('none')
  })

  it('releases an existing follow-up hold when the rep turns pausing off', () => {
    // Deal was paused (hold tracked the follow-up date); rep unchecks pause on
    // re-edit → the hold we placed is released so automation resumes.
    const d = decideFollowUpHold({
      newTemperature: 'deliberating',
      newFollowUpAt: future,
      oldHoldUntil: future,
      oldFollowUpAt: future,
      pauseAutomation: false,
      now,
    })
    expect(d.action).toBe('clear')
  })
})
