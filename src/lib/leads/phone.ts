/**
 * Phone normalization shared between /api/leads (single create)
 * and /api/leads/import (bulk import).
 *
 * Returns null if the input cannot produce a plausible E.164 number.
 * Supports US-defaulted normalization (10 digits → +1XXXXXXXXXX).
 */
export function formatToE164(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = raw.replace(/\D/g, '')
  if (cleaned.length < 10) return null
  if (cleaned.length > 15) return null
  return cleaned.startsWith('1') ? `+${cleaned}` : `+1${cleaned}`
}
