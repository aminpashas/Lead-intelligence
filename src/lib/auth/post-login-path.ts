/**
 * Where a freshly-authenticated user should land.
 *
 * - An `agency_admin` with NO active client goes to the Agency Console
 *   (`/agency`) — they manage practices, not a single CRM.
 * - An `agency_admin` who has "entered" a client account (`actingAsClient`,
 *   i.e. a row in `agency_active_org`) RESUMES that practice's dashboard
 *   (`/dashboard`) instead of being dumped back at the console.
 * - Every practice-level role goes straight to their dashboard.
 *
 * Kept dependency-free so it can be shared by the OAuth callback (server) and
 * the email-login page (client) — the two redirect paths must not drift.
 */
export function postLoginPath({
  role,
  actingAsClient,
}: {
  role: string | null | undefined
  actingAsClient: boolean
}): '/agency' | '/dashboard' {
  if (role === 'agency_admin' && !actingAsClient) {
    return '/agency'
  }
  return '/dashboard'
}
