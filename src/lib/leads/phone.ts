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

/**
 * Human/agent-readable rendering of a phone number for the voice agent to speak
 * as a callback number, e.g. "(415) 676-7420". Falls back to the raw input if it
 * can't be parsed as a US 10-digit number, so we never hand the agent an empty
 * string it might paper over by reading back the number it's dialing.
 */
export function formatPhoneForSpeech(raw: string | null | undefined): string {
  if (!raw) return ''
  const cleaned = raw.replace(/\D/g, '')
  const local = cleaned.length === 11 && cleaned.startsWith('1') ? cleaned.slice(1) : cleaned
  if (local.length !== 10) return raw
  return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`
}
