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
      '/api/webhooks/form', '/api/consent/confirm', '/api/cron/x', '/api/auth/setup',
      '/_next/static/chunk.js', '/widget.js',
    ]) {
      expect(isPublicPath(p), p).toBe(true)
    }
  })

  it('keeps the authenticated app gated', () => {
    for (const p of [
      '/dashboard', '/agency', '/pipeline', '/leads', '/conversations',
      '/api/leads', '/api/agency/practices',
    ]) {
      expect(isPublicPath(p), p).toBe(false)
    }
  })
})
