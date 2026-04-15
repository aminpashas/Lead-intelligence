/**
 * Application-level encryption for PII fields.
 *
 * Uses AES-256-GCM via Node.js crypto module.
 * Each encrypted value gets a unique IV, and the auth tag is appended
 * so decryption can verify data integrity.
 *
 * Storage format: base64(iv + authTag + ciphertext)
 * - IV: 12 bytes
 * - Auth Tag: 16 bytes
 * - Ciphertext: variable
 *
 * The encryption key must be a 32-byte hex string set in ENCRYPTION_KEY env var.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes, hkdfSync } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

// Prefix to identify encrypted values (avoids double-encryption)
const ENCRYPTED_PREFIX = 'enc::'

/**
 * Cached derived HMAC key — computed once via HKDF.
 * SEC-4: Using a separate key for HMAC prevents a compromised hash
 * from providing a known-ciphertext attack vector against the AES key.
 */
let _hmacKey: Buffer | null = null

function getKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY
  if (!key) {
    throw new Error('ENCRYPTION_KEY environment variable is required for PII encryption')
  }
  if (key.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)')
  }
  return Buffer.from(key, 'hex')
}

/**
 * Derive a separate HMAC key from the master key using HKDF.
 * SEC-4: Prevents using the same key for both AES-GCM encryption
 * and HMAC hashing. The HKDF context label ensures the derived key
 * is cryptographically independent of the master key.
 */
function getHmacKey(): Buffer {
  if (_hmacKey) return _hmacKey
  const masterKey = getKey()
  // HKDF: derive a 32-byte HMAC key with a distinct context label
  _hmacKey = Buffer.from(
    hkdfSync('sha256', masterKey, '', 'search-hash-hmac-v1', 32)
  )
  return _hmacKey
}

/**
 * Encrypt a plaintext string. Returns a prefixed base64 string.
 * Returns null if input is null/undefined.
 */
export function encryptField(plaintext: string | null | undefined): string | null {
  if (plaintext == null || plaintext === '') return plaintext as null
  if (plaintext.startsWith(ENCRYPTED_PREFIX)) return plaintext // already encrypted

  const key = getKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()

  // Pack: iv + authTag + ciphertext
  const packed = Buffer.concat([iv, authTag, encrypted])
  return ENCRYPTED_PREFIX + packed.toString('base64')
}

/**
 * Decrypt an encrypted field. Returns the plaintext string.
 * Returns null if input is null/undefined.
 * Passes through non-encrypted strings (for migration compatibility).
 */
export function decryptField(encrypted: string | null | undefined): string | null {
  if (encrypted == null || encrypted === '') return encrypted as null
  if (!encrypted.startsWith(ENCRYPTED_PREFIX)) return encrypted // plaintext passthrough

  const key = getKey()
  const packed = Buffer.from(encrypted.slice(ENCRYPTED_PREFIX.length), 'base64')

  if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Invalid encrypted value: too short')
  }

  const iv = packed.subarray(0, IV_LENGTH)
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH)

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ])
  return decrypted.toString('utf8')
}

/**
 * Generate a deterministic HMAC-SHA256 hash for search/lookup.
 * This allows querying encrypted fields without decrypting all rows.
 * The hash is one-way — the plaintext cannot be recovered from it.
 *
 * SEC-4: Uses a HKDF-derived key separate from the AES encryption key.
 */
export function searchHash(plaintext: string | null | undefined): string | null {
  if (plaintext == null || plaintext === '') return null
  const hmacKey = getHmacKey()
  return createHmac('sha256', hmacKey).update(plaintext.toLowerCase().trim()).digest('hex')
}

/**
 * Fields that should be encrypted at rest.
 * These are the HIPAA Safe Harbor identifiers stored in the leads table.
 */
export const PII_FIELDS = [
  'email',
  'phone',
  'phone_formatted',
  'date_of_birth',
  'insurance_provider',
  'insurance_details',
] as const

export type PIIField = typeof PII_FIELDS[number]

/**
 * Encrypt PII fields in a lead object before database insertion/update.
 * Only encrypts fields listed in PII_FIELDS. Non-PII fields pass through.
 * Also computes search hashes for email and phone fields.
 */
export function encryptLeadPII<T extends Record<string, unknown>>(data: T): T {
  const result: Record<string, unknown> = { ...data }
  for (const field of PII_FIELDS) {
    if (field in result && result[field] != null) {
      const value = result[field]
      if (typeof value === 'string') {
        result[field] = encryptField(value)
      } else if (typeof value === 'object') {
        result[field] = encryptField(JSON.stringify(value))
      }
    }
  }

  // Compute search hashes for lookup fields
  if ('email' in data && data.email) {
    result.email_hash = searchHash(data.email as string)
  }
  if ('phone_formatted' in data && data.phone_formatted) {
    result.phone_hash = searchHash(data.phone_formatted as string)
  } else if ('phone' in data && data.phone) {
    result.phone_hash = searchHash(data.phone as string)
  }

  return result as T
}

/**
 * Decrypt PII fields in a lead object after database retrieval.
 */
export function decryptLeadPII<T extends Record<string, unknown>>(data: T): T {
  const result: Record<string, unknown> = { ...data }
  for (const field of PII_FIELDS) {
    if (field in result && result[field] != null) {
      const value = result[field]
      if (typeof value === 'string') {
        const decrypted = decryptField(value)
        if (field === 'insurance_details' && decrypted) {
          try {
            result[field] = JSON.parse(decrypted)
          } catch {
            result[field] = decrypted
          }
        } else {
          result[field] = decrypted
        }
      }
    }
  }
  return result as T
}

/**
 * Decrypt an array of lead objects.
 */
export function decryptLeadsPII<T extends Record<string, unknown>>(leads: T[]): T[] {
  return leads.map(decryptLeadPII)
}

/**
 * Generate a new encryption key (for initial setup).
 * Run: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString('hex')
}
