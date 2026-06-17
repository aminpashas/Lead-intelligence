import { describe, it, expect } from 'vitest'
import { detectA2pTransition } from '@/lib/messaging/a2p'

describe('detectA2pTransition', () => {
  it('no status returned → silent', () => {
    const t = detectA2pTransition('IN_PROGRESS', null)
    expect(t.changed).toBe(false)
    expect(t.severity).toBe('none')
  })

  it('unchanged status → silent', () => {
    const t = detectA2pTransition('IN_PROGRESS', 'IN_PROGRESS')
    expect(t.changed).toBe(false)
    expect(t.severity).toBe('none')
  })

  it('→ VERIFIED is a good transition', () => {
    const t = detectA2pTransition('IN_PROGRESS', 'VERIFIED')
    expect(t.changed).toBe(true)
    expect(t.severity).toBe('good')
    expect(t.message).toMatch(/VERIFIED/)
  })

  it('→ FAILED is critical', () => {
    const t = detectA2pTransition('IN_PROGRESS', 'FAILED')
    expect(t.changed).toBe(true)
    expect(t.severity).toBe('critical')
  })

  it('first observation (no prior) of a non-terminal status is info', () => {
    const t = detectA2pTransition(null, 'IN_PROGRESS')
    expect(t.changed).toBe(true)
    expect(t.severity).toBe('info')
  })

  it('is case-insensitive on the target status', () => {
    expect(detectA2pTransition('in_progress', 'verified').severity).toBe('good')
  })
})
