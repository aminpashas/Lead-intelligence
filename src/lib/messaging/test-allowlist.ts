/**
 * TEST-MODE send allowlist — a hard clamp at the lowest send layer.
 *
 * When `TEST_SEND_ALLOWLIST` is set (comma-separated phone numbers and/or email
 * addresses), the low-level sendSMS / sendEmail / sendBatchEmails refuse to
 * deliver to any recipient NOT on the list. Because every higher-level send path
 * (sendSMSToLead, sendEmailToLead, campaign/cron/agent-tool sends, and raw
 * transactional sends) ultimately calls one of those primitives, this single
 * switch guarantees that while AI workflows are being tested, no real patient can
 * be reached — regardless of consent state, feature flags, crons, or code path.
 *
 * Unset or empty => disabled (normal production behavior; allow all).
 *
 * Matching: phones compared on their last 10 digits (so "+14155551234",
 * "14155551234", and "4155551234" all match); emails compared case-insensitively.
 *
 * IMPORTANT: to protect the production Vercel crons/webhooks, this env var must be
 * set in the Vercel project environment, not only in .env.local.
 */

let cache: { raw: string; phones: Set<string>; emails: Set<string> } | null = null

function normalizePhone(value: string): string {
  const digits = value.replace(/[^0-9]/g, '')
  return digits.length > 10 ? digits.slice(-10) : digits
}

function parse(): { phones: Set<string>; emails: Set<string> } {
  const raw = process.env.TEST_SEND_ALLOWLIST ?? ''
  if (cache && cache.raw === raw) return cache
  const phones = new Set<string>()
  const emails = new Set<string>()
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (entry.includes('@')) emails.add(entry.toLowerCase())
    else phones.add(normalizePhone(entry))
  }
  cache = { raw, phones, emails }
  return cache
}

/**
 * DRY-RUN switch — the strongest send clamp. When `MESSAGING_DRY_RUN` is truthy
 * ("1"/"true"/"yes"/"on"), the low-level sendSMS / sendEmail / sendBatchEmails log
 * the intended send and return a synthetic "blocked" result WITHOUT calling
 * Twilio/Resend. Nothing physically leaves the system — to ANYONE. Stronger than
 * the allowlist (which still delivers to listed numbers): use it in smoke tests
 * and scripts so a stray/mistaken run can never reach a real person.
 *
 * Unset / empty / "0" / "false" => disabled (normal delivery).
 */
export function messagingDryRun(): boolean {
  const v = (process.env.MESSAGING_DRY_RUN ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/** True when the allowlist is active (env set to a non-empty list). */
export function testAllowlistActive(): boolean {
  const { phones, emails } = parse()
  return phones.size > 0 || emails.size > 0
}

/**
 * Whether a single recipient (phone or email) may be sent to.
 * Returns true for everyone when the allowlist is disabled (no env / empty).
 */
export function isSendAllowed(to: string): boolean {
  const { phones, emails } = parse()
  if (phones.size === 0 && emails.size === 0) return true // disabled → allow all
  if (to.includes('@')) return emails.has(to.trim().toLowerCase())
  return phones.has(normalizePhone(to))
}
