/**
 * Appointment action tokens (confirm / reschedule).
 *
 * A token is `apt:<appointmentId>:<orgId>:<issuedAtMs>` base64url-encoded and
 * embedded in reminder-email links. It is a low-privilege capability: it lets
 * the holder confirm or self-reschedule ONE appointment. It does NOT expose or
 * let anyone edit patient identity, so a 14-day validity window is a reasonable
 * balance between letting patients act on a reminder and not leaving a link that
 * works forever if an old inbox is compromised.
 */

/** How long a confirm/reschedule link stays valid after it was issued. */
export const APPOINTMENT_TOKEN_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

export type DecodedAppointmentToken = {
  appointmentId: string
  orgId: string
  /** Epoch ms the token was minted, or null for legacy tokens with no timestamp. */
  issuedAt: number | null
}

export type TokenDecodeResult =
  | { ok: true; token: DecodedAppointmentToken }
  | { ok: false; reason: 'invalid' | 'expired' }

/**
 * Decode and validate an appointment token. Rejects malformed tokens and any
 * token older than {@link APPOINTMENT_TOKEN_MAX_AGE_MS}. Legacy tokens minted
 * before we stamped a timestamp (no 4th segment) are treated as expired so they
 * fail closed rather than living forever.
 */
export function decodeAppointmentToken(token: string | null | undefined): TokenDecodeResult {
  if (!token) return { ok: false, reason: 'invalid' }

  let decoded: string
  try {
    decoded = Buffer.from(token, 'base64url').toString()
  } catch {
    return { ok: false, reason: 'invalid' }
  }

  const parts = decoded.split(':')
  if (parts.length < 3 || parts[0] !== 'apt' || !parts[1] || !parts[2]) {
    return { ok: false, reason: 'invalid' }
  }

  const issuedAt = parts.length >= 4 ? Number(parts[3]) : NaN
  if (!Number.isFinite(issuedAt)) {
    // No/invalid timestamp → fail closed as expired (legacy long-lived link).
    return { ok: false, reason: 'expired' }
  }

  if (Date.now() - issuedAt > APPOINTMENT_TOKEN_MAX_AGE_MS) {
    return { ok: false, reason: 'expired' }
  }

  return { ok: true, token: { appointmentId: parts[1], orgId: parts[2], issuedAt } }
}
