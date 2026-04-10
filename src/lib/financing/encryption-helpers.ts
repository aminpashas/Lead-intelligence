import { encryptField, decryptField, searchHash } from '@/lib/encryption'
import type { ApplicantData } from './types'

/**
 * Encrypt the full applicant data blob (SSN, income, address, DOB, etc.)
 * into a single AES-256-GCM encrypted string for database storage.
 */
export function encryptApplicantData(data: ApplicantData): string {
  const json = JSON.stringify(data)
  const encrypted = encryptField(json)
  if (!encrypted) {
    throw new Error('Failed to encrypt applicant data — ENCRYPTION_KEY may be missing')
  }
  return encrypted
}

/**
 * Decrypt the applicant data blob back into structured data.
 * Only called server-side during waterfall execution.
 */
export function decryptApplicantData(encrypted: string): ApplicantData {
  const json = decryptField(encrypted)
  if (!json) {
    throw new Error('Failed to decrypt applicant data — ENCRYPTION_KEY may have rotated')
  }
  return JSON.parse(json) as ApplicantData
}

/**
 * Create an HMAC-SHA256 hash of an SSN for deduplication.
 * Allows checking "has this person already applied?" without
 * decrypting the stored data.
 */
export function hashSSN(ssn: string): string | null {
  return searchHash(ssn)
}

/**
 * Encrypt lender API credentials blob for database storage.
 */
export function encryptCredentials(credentials: Record<string, string>): string {
  const json = JSON.stringify(credentials)
  const encrypted = encryptField(json)
  if (!encrypted) {
    throw new Error('Failed to encrypt lender credentials — ENCRYPTION_KEY may be missing')
  }
  return encrypted
}

/**
 * Decrypt lender API credentials from database.
 */
export function decryptCredentials(encrypted: string): Record<string, string> {
  const json = decryptField(encrypted)
  if (!json) {
    throw new Error('Failed to decrypt lender credentials — ENCRYPTION_KEY may have rotated')
  }
  return JSON.parse(json) as Record<string, string>
}

/**
 * Mask an SSN for display purposes: "***-**-1234"
 * SSN is never returned to the client in full.
 */
export function maskSSN(ssn: string): string {
  if (!ssn || ssn.length < 4) return '***-**-****'
  const last4 = ssn.slice(-4)
  return `***-**-${last4}`
}

/**
 * PHI categories transmitted during financing operations.
 * Used for HIPAA audit logging.
 */
export const FINANCING_PHI_CATEGORIES = [
  'ssn',
  'financial',
  'name',
  'dob',
  'address',
  'phone',
  'email',
] as const

export type FinancingPHICategory = typeof FINANCING_PHI_CATEGORIES[number]
