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
  '/auth/callback', // OAuth handler — must run pre-session
  '/qualify',
  '/optin',
  '/book',
  '/all-on-4',
  '/contract/',
  '/case/',   // patient treatment-plan portal (share-token gated in the API)
  '/preop/',  // patient pre-op instructions portal (share-token gated)
  '/finance/', // patient financing portal — application, co-signer, and checkout resume (token-gated in the API)
  '/api/contracts/patient',
  '/api/consent',
  '/api/financing/apply', // public financing submission (share-token gated; staff flow still self-auths)
  '/api/booking',
  '/api/webhooks',
  '/api/cron',
  '/api/auth',
  '/_next',
  '/widget.js',
] as const

/**
 * True when `pathname` should bypass the auth gate. Mirrors the original inline
 * middleware condition: any public prefix, or any path containing a `.` (static
 * assets like `/favicon.ico`, `/widget.js`).
 */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix)) || pathname.includes('.')
}
