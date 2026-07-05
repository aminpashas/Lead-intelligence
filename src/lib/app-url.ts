/**
 * Trusted public base URL for links we send OUTSIDE the app — patient
 * confirmation/reschedule emails, SMS links, financing portals, webhook
 * callbacks, etc.
 *
 * Why this exists: `NEXT_PUBLIC_APP_URL` is read at *runtime* from whatever
 * deployment executes the job. If a preview/branch deployment (or a local box)
 * ever runs a reminder, its `NEXT_PUBLIC_APP_URL` can be a per-deployment
 * Vercel preview host like
 *   lead-intelligence-24rn9frob-aminpashas-projects.vercel.app
 * Those hosts are immutable snapshots of one commit — a link baked into an
 * email that points at one 404s the moment newer code (or no matching route)
 * is what that snapshot serves. Patient-facing links must only ever use a
 * STABLE host. This helper refuses ephemeral hosts and falls back to the
 * canonical production URL.
 */

/**
 * Canonical production URL — the trusted fallback whenever
 * `NEXT_PUBLIC_APP_URL` is missing or points at an ephemeral host.
 * Override with `APP_CANONICAL_URL` if the production domain changes
 * (e.g. a custom domain like https://app.dionhealth.com).
 *
 * Read at call time (not module-load) so the resolved value always reflects
 * the current environment.
 */
function canonicalAppUrl(): string {
  return (
    process.env.APP_CANONICAL_URL || 'https://lead-intelligence-jet.vercel.app'
  ).replace(/\/$/, '')
}

/**
 * True when a host must NOT appear in an outbound patient-facing link.
 *
 * Untrusted =
 *   - loopback / local dev hosts (localhost, 127.0.0.1, 0.0.0.0), or
 *   - Vercel's auto-generated per-deployment URLs. Those are team-scoped and
 *     carry the `-<team>-projects.vercel.app` suffix (e.g.
 *     `…-aminpashas-projects.vercel.app`). Assigned production aliases like
 *     `lead-intelligence-jet.vercel.app` do NOT carry that suffix, and real
 *     custom domains aren't on `vercel.app` at all — so both stay trusted.
 */
function isEphemeralHost(host: string): boolean {
  const h = host.toLowerCase()
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0') return true
  if (h.endsWith('-projects.vercel.app')) return true
  return false
}

/**
 * Resolve the base URL to use for links sent outside the app.
 * Returns a normalized origin with no trailing slash.
 */
export function getPublicAppUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim()
  if (!configured) return canonicalAppUrl()

  let host: string
  try {
    host = new URL(configured).hostname
  } catch {
    // Not a parseable URL — don't risk emitting garbage into a patient email.
    return canonicalAppUrl()
  }

  if (isEphemeralHost(host)) return canonicalAppUrl()
  return configured.replace(/\/$/, '')
}
