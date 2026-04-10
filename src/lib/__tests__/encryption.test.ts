import { describe, it, expect, beforeAll } from 'vitest'
import { encryptField, decryptField, encryptLeadPII, decryptLeadPII } from '../encryption'

// Set a test encryption key (32 bytes = 64 hex chars)
beforeAll(() => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64)
})

describe('encryptField / decryptField', () => {
  it('encrypts and decrypts a string', () => {
    const plaintext = 'john@example.com'
    const encrypted = encryptField(plaintext)
    expect(encrypted).not.toBeNull()
    expect(encrypted).toMatch(/^enc::/)
    expect(encrypted).not.toContain(plaintext)

    const decrypted = decryptField(encrypted)
    expect(decrypted).toBe(plaintext)
  })

  it('returns null/undefined for null/undefined inputs', () => {
    expect(encryptField(null)).toBeNull()
    expect(encryptField(undefined)).toBeUndefined()
    expect(decryptField(null)).toBeNull()
    expect(decryptField(undefined)).toBeUndefined()
  })

  it('does not double-encrypt', () => {
    const encrypted = encryptField('test@test.com')!
    const doubleEncrypted = encryptField(encrypted)
    expect(doubleEncrypted).toBe(encrypted)
  })

  it('passes through non-encrypted strings on decrypt', () => {
    expect(decryptField('plain text')).toBe('plain text')
  })

  it('generates unique ciphertext for same plaintext (random IV)', () => {
    const a = encryptField('same-value')
    const b = encryptField('same-value')
    expect(a).not.toBe(b)

    expect(decryptField(a)).toBe('same-value')
    expect(decryptField(b)).toBe('same-value')
  })
})

describe('encryptLeadPII / decryptLeadPII', () => {
  it('encrypts only PII fields', () => {
    const lead = {
      id: '123',
      first_name: 'John',
      last_name: 'Smith',
      email: 'john@example.com',
      phone: '+14155551234',
      phone_formatted: '+14155551234',
      date_of_birth: '1985-03-15',
      status: 'new',
      ai_score: 75,
    }

    const encrypted = encryptLeadPII(lead)

    // Non-PII fields unchanged
    expect(encrypted.id).toBe('123')
    expect(encrypted.first_name).toBe('John')
    expect(encrypted.last_name).toBe('Smith')
    expect(encrypted.status).toBe('new')
    expect(encrypted.ai_score).toBe(75)

    // PII fields encrypted
    expect(encrypted.email).toMatch(/^enc::/)
    expect(encrypted.phone).toMatch(/^enc::/)
    expect(encrypted.phone_formatted).toMatch(/^enc::/)
    expect(encrypted.date_of_birth).toMatch(/^enc::/)

    // Decrypt roundtrip
    const decrypted = decryptLeadPII(encrypted)
    expect(decrypted.email).toBe('john@example.com')
    expect(decrypted.phone).toBe('+14155551234')
    expect(decrypted.date_of_birth).toBe('1985-03-15')
  })

  it('handles JSONB fields (insurance_details)', () => {
    const lead = {
      insurance_details: { provider: 'Aetna', plan_id: 'PPO-123' },
    }
    const encrypted = encryptLeadPII(lead as any)
    expect(encrypted.insurance_details).toMatch(/^enc::/)

    const decrypted = decryptLeadPII(encrypted as any)
    expect(decrypted.insurance_details).toEqual({ provider: 'Aetna', plan_id: 'PPO-123' })
  })
})
