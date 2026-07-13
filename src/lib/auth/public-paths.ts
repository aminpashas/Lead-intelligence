/**
 * Path prefixes that bypass the auth gate in `src/middleware.ts`. These are
 * public-facing (patient portals, opt-in), self-authenticating handlers, or
 * infra paths.
 *
 * CRITICAL: `/auth/callback` MUST be here. The OAuth callback runs BEFORE a
 * session exists — it exchanges the `?code=` that *creates* the session. If the
 * auth gate runs first it finds no user and redirects to /login before the
 * handler executes, so the code is never exchanged: an endless Google↔app
 * OAuth loop. (Email/password login is client-side and never hits this route,
 * which is why it kept working while OAuth was broken.)
 */
export const PUBLIC_PREFIXES = [
  '/login',
  '/signup',
  '/accept-invite', // team-invite set-password page — runs pre-session (token in query)
  '/auth/callback', // OAuth handler — must run pre-session
  '/qualify',
  '/optin',
  '/book',
  '/reschedule', // patient self-serve reschedule calendar (token in query string)
  '/all-on-4',
  '/contract/',
  '/case/',   // patient treatment-plan portal (share-token gated in the API)
  '/preop/',  // patient pre-op instructions portal (share-token gated)
  '/finance/', // patient / co-signer financing application portal (share-token gated)
  '/api/contracts/patient',
  '/api/consent',
  '/api/financing/apply', // public financing submission (share-token gated; staff flow still self-auths)
  '/api/booking',
  '/api/webhooks',
  '/api/cron',
  // Patient share-token portals (token is the capability; no session exists).
  '/api/preop',         // pre-op instructions (share_token in path)
  '/api/cases/patient', // treatment-plan view/accept (share_token in path)
  // Self-authenticating machine callers — they verify a signature / service key
  // rather than a session cookie, so the middleware auth backstop must not 401
  // them (a legitimate caller never carries a session).
  '/api/voice',         // Retell webhook signature / x-transfer-secret / bearer
  '/api/v1',            // service key (verifyServiceKey + org allowlist)
  // Email-link actions clicked from a mail client (no session). The handler
  // authenticates the request via a signed token in the query string.
  '/api/email/unsubscribe',
  // Appointment email-link actions (no session; a signed token in the query
  // string is the capability). Scoped to the exact subpaths — the rest of
  // /api/appointments stays behind the auth gate.
  '/api/appointments/confirm',
  '/api/appointments/reschedule',
  '/_next',
] as const

/**
 * Exact static-asset paths that bypass the auth gate. Deliberately NOT a
 * "path contains a dot" heuristic (nor an extension regex): Next.js dynamic
 * segments accept dots, so `/leads/123.css` or a page route like
 * `/sidebar.preview` would ride any dot heuristic straight past the gate.
 * The middleware matcher already excludes `/_next/*`, `favicon.ico`, and
 * common asset extensions (.svg/.png/.js/.css/…) before this code runs, so
 * this set only needs the stragglers. A new public file that's missing from
 * here fails loudly (login redirect) instead of a private route leaking.
 */
export const PUBLIC_FILES = new Set<string>([
  '/favicon.ico',
  '/widget.js',
  '/qualify-widget.js',
  '/sw.js',
  '/robots.txt',
  '/sitemap.xml',
  '/manifest.webmanifest', // served by src/app/manifest.ts
])

/** True when `pathname` should bypass the auth gate in `src/middleware.ts`. */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_FILES.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}
