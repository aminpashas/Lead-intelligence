/**
 * Test-send allowlist — the safety gate for all new auto-send paths.
 *
 * When `TEST_SEND_ALLOWLIST` is non-empty (comma-separated phones/emails), ONLY
 * those recipients may be messaged; every other recipient is refused. Clearing
 * the env var lifts the gate entirely (production behavior — allow all).
 *
 * Pure + env-injectable so it unit-tests without mocks.
 */

export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/** True if `recipient` may be messaged. Empty allowlist ⇒ gate off ⇒ allow all. */
export function isAllowlisted(
  recipient: string,
  raw: string | undefined = process.env.TEST_SEND_ALLOWLIST
): boolean {
  const list = parseAllowlist(raw)
  if (list.length === 0) return true
  return list.includes((recipient ?? '').trim().toLowerCase())
}

/** True when the allowlist gate is actively restricting sends. */
export function allowlistActive(raw: string | undefined = process.env.TEST_SEND_ALLOWLIST): boolean {
  return parseAllowlist(raw).length > 0
}
