import { describe, it, expect } from 'vitest'
import { DEFAULT_DISCOVERY_SCRIPT, resolveDiscoveryScript } from '@/lib/ai/discovery-script'

describe('resolveDiscoveryScript', () => {
  it('returns the default when no override is provided', () => {
    expect(resolveDiscoveryScript()).toBe(DEFAULT_DISCOVERY_SCRIPT)
    expect(resolveDiscoveryScript(null)).toBe(DEFAULT_DISCOVERY_SCRIPT)
    expect(resolveDiscoveryScript(undefined)).toBe(DEFAULT_DISCOVERY_SCRIPT)
  })

  it('treats a blank/whitespace override as no override', () => {
    expect(resolveDiscoveryScript('')).toBe(DEFAULT_DISCOVERY_SCRIPT)
    expect(resolveDiscoveryScript('   \n  ')).toBe(DEFAULT_DISCOVERY_SCRIPT)
  })

  it('returns a real override verbatim', () => {
    expect(resolveDiscoveryScript('Our custom script')).toBe('Our custom script')
  })
})
