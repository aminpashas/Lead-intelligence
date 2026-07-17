/**
 * Shared lead display name.
 *
 * A lead's name columns can legitimately be empty: upstream often has no name
 * (see `phone-name.ts` — we now null out phone numbers that were parsed into the
 * name columns rather than showing "Hi (925)," to a patient). Before this helper
 * existed most surfaces rendered `{first_name} {last_name}` raw, so a nameless
 * lead rendered as a BLANK row — worse than the phone number it replaced.
 *
 * Every surface that shows a lead name should go through here so the fallback is
 * decided once. Order: real name → phone → "Unknown".
 *
 * Callers must pass an already-DECRYPTED row. `phone` is `enc::`-encrypted at
 * rest; handing this an encrypted row would render "enc::AbC…" as the name, so
 * server pages must run `decryptLeadsPII` first (see pii-decrypt-server-pages).
 */

type LeadNameFields = {
  first_name?: string | null
  last_name?: string | null
  phone_formatted?: string | null
  phone?: string | null
}

const ENCRYPTED_PREFIX = 'enc::'

/** Never surface an encryption envelope as if it were a human-readable value. */
function plaintext(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  if (!trimmed || trimmed.startsWith(ENCRYPTED_PREFIX)) return null
  return trimmed
}

/**
 * Human label for a lead. Falls back to the phone number, then a generic string,
 * so this never returns empty.
 */
export function leadDisplayName(
  lead: LeadNameFields | null | undefined,
  fallback = 'Unknown',
): string {
  if (!lead) return fallback
  const first = plaintext(lead.first_name)
  const last = plaintext(lead.last_name)
  const full = [first, last].filter(Boolean).join(' ').trim()
  if (full) return full
  return plaintext(lead.phone_formatted) ?? plaintext(lead.phone) ?? fallback
}

/**
 * Avatar initials matching `leadDisplayName`. Derived from the same string the
 * user sees, so a nameless lead gets initials from its phone rather than the
 * empty circle a raw `first_name?.[0]` produces. Digits are dropped (a phone
 * yields no meaningful initials), leaving an empty string for the caller to
 * render as a neutral placeholder.
 */
export function leadInitials(lead: LeadNameFields | null | undefined): string {
  const first = plaintext(lead?.first_name)
  const last = plaintext(lead?.last_name)
  return `${first?.[0] ?? ''}${last?.[0] ?? ''}`.replace(/[^a-z]/gi, '').toUpperCase()
}
