import { describe, it, expect } from 'vitest'
import { isPublicPath } from '@/lib/auth/public-paths'

// Regression: the OAuth callback runs BEFORE a session exists (it exchanges the
// code that creates the session). If middleware gates it, it redirects to
// /login before the handler runs — an endless Google↔app OAuth loop. So
// /auth/callback MUST be a public path.

describe('isPublicPath', () => {
  it('treats the OAuth callback as public (the loop regression guard)', () => {
    expect(isPublicPath('/auth/callback')).toBe(true)
  })

  it('keeps auth + public patient routes public', () => {
    for (const p of [
      '/login', '/signup',
      '/optin/abc123', '/qualify/org_1', '/book', '/all-on-4',
      '/contract/xyz',
      '/api/webhooks/form', '/api/consent/confirm', '/api/cron/x',
      // Patient share-token portals + email-link + self-authenticating machine APIs.
      '/api/preop/abc', '/api/cases/patient/xyz', '/api/cases/patient/xyz/accept',
      '/api/email/unsubscribe', '/api/voice/events', '/api/v1/leads',
      '/_next/static/chunk.js', '/widget.js',
    ]) {
      expect(isPublicPath(p), p).toBe(true)
    }
  })

  it('keeps the authenticated app gated', () => {
    for (const p of [
      '/dashboard', '/agency', '/pipeline', '/leads', '/conversations',
      '/api/leads', '/api/agency/practices',
      // Deleted dead route + the formerly-unauthenticated service-role routes
      // are no longer public (they now self-authenticate).
      '/api/auth/setup', '/api/content/deliver', '/api/content/assets',
    ]) {
      expect(isPublicPath(p), p).toBe(false)
    }
  })
})
