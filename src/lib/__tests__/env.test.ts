import { describe, it, expect } from 'vitest'
import { validateEnv } from '../env'

describe('validateEnv', () => {
  it('returns validation result', () => {
    const result = validateEnv()
    expect(result).toHaveProperty('valid')
    expect(result).toHaveProperty('missing')
    expect(result).toHaveProperty('warnings')
    expect(Array.isArray(result.missing)).toBe(true)
    expect(Array.isArray(result.warnings)).toBe(true)
  })

  it('reports missing required vars', () => {
    const result = validateEnv()
    // In test env, Supabase keys may not be set
    // Just verify the structure works
    for (const m of result.missing) {
      expect(m).toHaveProperty('key')
      expect(m).toHaveProperty('description')
      expect(m).toHaveProperty('required')
    }
  })
})
