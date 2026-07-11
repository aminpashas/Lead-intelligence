import { describe, it, expect } from 'vitest'
import { resolveReconcileTarget, normalizeStageName } from '@/lib/ghl/reconcile-map'
import type { LiStageSlug } from '@/lib/ghl/reconcile-map'

describe('normalizeStageName', () => {
  it('lowercases, collapses whitespace, and normalizes en/em dashes', () => {
    expect(normalizeStageName('Closed – Accepted')).toBe('closed - accepted')
    expect(normalizeStageName('  No   Communication ')).toBe('no communication')
  })
})

describe('resolveReconcileTarget', () => {
  it('maps won/accepted stages to contract-signed and suppresses outreach', () => {
    expect(resolveReconcileTarget('Closed – Accepted')).toEqual({ stageSlug: 'contract-signed', suppressOutreach: true })
    expect(resolveReconcileTarget('Accepted Treatment')).toMatchObject({ stageSlug: 'contract-signed' })
    expect(resolveReconcileTarget('Closed Won')).toMatchObject({ stageSlug: 'contract-signed' })
  })

  it('maps not-interested / lost stages to lost', () => {
    expect(resolveReconcileTarget('Not Interested / Disqualified')).toMatchObject({ stageSlug: 'lost' })
    expect(resolveReconcileTarget('Closed Lost')).toMatchObject({ stageSlug: 'lost' })
    expect(resolveReconcileTarget('Out of Area')).toMatchObject({ stageSlug: 'lost' })
  })

  it('preserves the operational columns', () => {
    expect(resolveReconcileTarget('No Communication')).toEqual({ stageSlug: 'no-communication' })
    expect(resolveReconcileTarget('DND SMS')).toEqual({ stageSlug: 'dnd-sms', smsDnd: true })
  })

  it('flags generic Do Not Disturb as all-channel suppression', () => {
    expect(resolveReconcileTarget('Do Not Disturb')).toEqual({
      stageSlug: 'lost', suppressOutreach: true, allChannelDnd: true,
    })
  })

  it('resolves bare "Closed" only via opportunity status', () => {
    expect(resolveReconcileTarget('Closed', 'won')).toMatchObject({ stageSlug: 'contract-signed' })
    expect(resolveReconcileTarget('Closed', 'lost')).toMatchObject({ stageSlug: 'lost' })
    expect(resolveReconcileTarget('Closed', 'abandoned')).toMatchObject({ stageSlug: 'lost' })
    // Ambiguous (open / unknown) — never guess.
    expect(resolveReconcileTarget('Closed', 'open')).toBeNull()
    expect(resolveReconcileTarget('Closed')).toBeNull()
  })

  it('is fail-safe: unknown stages return null (caller skips, never resets to New)', () => {
    expect(resolveReconcileTarget('Some Brand New GHL Stage')).toBeNull()
    expect(resolveReconcileTarget('')).toBeNull()
    expect(resolveReconcileTarget(undefined)).toBeNull()
  })

  it('keeps stalled deals active for re-engagement', () => {
    expect(resolveReconcileTarget('Treatment Plan Not Accepted')).toMatchObject({ stageSlug: 'treatment-presented' })
    expect(resolveReconcileTarget('Denied Financing')).toMatchObject({ stageSlug: 'financing' })
  })
})

describe('engaged slug', () => {
  it('accepts engaged as a valid LiStageSlug (LI-derived, no GHL name maps to it)', () => {
    const s: LiStageSlug = 'engaged'
    expect(s).toBe('engaged')
  })
  it('still maps the whole contacted family to contacted (Following Up)', () => {
    expect(resolveReconcileTarget('1st Call')).toEqual({ stageSlug: 'contacted' })
    expect(resolveReconcileTarget('Follow Up Needed')).toEqual({ stageSlug: 'contacted' })
  })
  it('has no STAGE_TABLE entry resolving to engaged', () => {
    // engaged is assigned by LI signals only; assert no GHL name yields it
    const names = ['contacted', 'engaged', 'replied', 'active communication', 'follow up']
    for (const n of names) {
      const t = resolveReconcileTarget(n)
      expect(t?.stageSlug).not.toBe('engaged')
    }
  })
})
