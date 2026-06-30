import { describe, it, expect } from 'vitest'
import { postLoginPath } from '@/lib/auth/post-login-path'

// Regression: an agency_admin who has "entered" a practice (actingAsClient)
// must resume that practice's dashboard after login, NOT get dumped at the
// Agency Console. The callback/login previously routed every agency_admin to
// /agency, ignoring their active-practice selection.

describe('postLoginPath', () => {
  it('agency_admin with NO active client → /agency (Agency Console)', () => {
    expect(postLoginPath({ role: 'agency_admin', actingAsClient: false })).toBe('/agency')
  })

  it('agency_admin who entered a client → /dashboard (resumes the practice)', () => {
    expect(postLoginPath({ role: 'agency_admin', actingAsClient: true })).toBe('/dashboard')
  })

  it('every practice-level role → /dashboard', () => {
    const practiceRoles = [
      'owner', 'admin', 'manager', 'member',
      'doctor_admin', 'doctor', 'nurse', 'assistant',
      'treatment_coordinator', 'office_manager',
    ]
    for (const role of practiceRoles) {
      expect(postLoginPath({ role, actingAsClient: false })).toBe('/dashboard')
    }
  })

  it('null/unprovisioned role → /dashboard (the dashboard layout owns the bounce)', () => {
    expect(postLoginPath({ role: null, actingAsClient: false })).toBe('/dashboard')
    expect(postLoginPath({ role: undefined, actingAsClient: false })).toBe('/dashboard')
  })
})
