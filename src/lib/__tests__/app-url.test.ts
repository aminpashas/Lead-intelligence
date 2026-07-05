import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getPublicAppUrl } from '@/lib/app-url'

/**
 * Guards the fix for the "confirm appointment → 404" bug: a patient email link
 * was built from a per-deployment Vercel preview host that didn't serve the
 * route. getPublicAppUrl() must never emit an ephemeral host into an outbound
 * link — it falls back to the canonical production URL instead.
 */
describe('getPublicAppUrl', () => {
  const original = process.env.NEXT_PUBLIC_APP_URL
  const originalCanonical = process.env.APP_CANONICAL_URL

  beforeEach(() => {
    delete process.env.APP_CANONICAL_URL
  })
  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = original
    process.env.APP_CANONICAL_URL = originalCanonical
  })

  const CANONICAL = 'https://lead-intelligence-jet.vercel.app'

  it('falls back to canonical when unset', () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    expect(getPublicAppUrl()).toBe(CANONICAL)
  })

  it('rejects a Vercel per-deployment preview host (the reported 404 cause)', () => {
    process.env.NEXT_PUBLIC_APP_URL =
      'https://lead-intelligence-24rn9frob-aminpashas-projects.vercel.app'
    expect(getPublicAppUrl()).toBe(CANONICAL)
  })

  it('rejects localhost', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3001'
    expect(getPublicAppUrl()).toBe(CANONICAL)
  })

  it('trusts the assigned production alias', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://lead-intelligence-jet.vercel.app'
    expect(getPublicAppUrl()).toBe(CANONICAL)
  })

  it('trusts a real custom domain and strips a trailing slash', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.dionhealth.com/'
    expect(getPublicAppUrl()).toBe('https://app.dionhealth.com')
  })

  it('honors APP_CANONICAL_URL override for the fallback', () => {
    process.env.APP_CANONICAL_URL = 'https://app.dionhealth.com'
    delete process.env.NEXT_PUBLIC_APP_URL
    expect(getPublicAppUrl()).toBe('https://app.dionhealth.com')
  })

  it('falls back when the configured value is not a valid URL', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'not-a-url'
    expect(getPublicAppUrl()).toBe(CANONICAL)
  })
})
