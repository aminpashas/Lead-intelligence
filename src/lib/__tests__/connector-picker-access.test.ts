import { describe, it, expect } from 'vitest'
import { evaluateConnectorPickerAccess } from '@/lib/auth/active-org'

// Regression: the OAuth picker pages (/settings/connectors/{google,meta}/select)
// must use the SAME agency-owned gate as the connect/callback/finalize routes.
// They previously gated on ['owner','admin'] (excluding agency_admin entirely)
// and compared the pending state's org against the admin's HOME org — so the
// only role that can mint a valid state (an agency_admin inside a client) was
// rejected twice over. The gate now resolves the EFFECTIVE acting org.

const CLIENT = 'client-org-uuid'
const HOME = 'agency-home-org-uuid'

describe('evaluateConnectorPickerAccess', () => {
  it('agency_admin inside a client, state belongs to that client → ok', () => {
    expect(
      evaluateConnectorPickerAccess({
        role: 'agency_admin',
        actingAsClient: true,
        activeOrgId: CLIENT,
        stateOrgId: CLIENT,
      })
    ).toEqual({ ok: true, orgId: CLIENT })
  })

  it('state belongs to a DIFFERENT org than the one entered → state_org_mismatch', () => {
    // CSRF/ownership: no cross-tenant finalization, even for an agency admin.
    expect(
      evaluateConnectorPickerAccess({
        role: 'agency_admin',
        actingAsClient: true,
        activeOrgId: CLIENT,
        stateOrgId: 'some-other-client',
      })
    ).toEqual({ ok: false, error: 'state_org_mismatch' })
  })

  it('agency_admin who has NOT entered a client → no_active_account', () => {
    expect(
      evaluateConnectorPickerAccess({
        role: 'agency_admin',
        actingAsClient: false,
        activeOrgId: HOME,
        stateOrgId: CLIENT,
      })
    ).toEqual({ ok: false, error: 'no_active_account' })
  })

  it('actingAsClient true but no resolved org → no_active_account', () => {
    expect(
      evaluateConnectorPickerAccess({
        role: 'agency_admin',
        actingAsClient: true,
        activeOrgId: null,
        stateOrgId: CLIENT,
      })
    ).toEqual({ ok: false, error: 'no_active_account' })
  })

  it('practice-level roles are rejected (connector flow is agency-owned) → forbidden', () => {
    for (const role of ['owner', 'admin', 'manager', 'member']) {
      expect(
        evaluateConnectorPickerAccess({
          role,
          actingAsClient: false,
          activeOrgId: CLIENT,
          stateOrgId: CLIENT,
        })
      ).toEqual({ ok: false, error: 'forbidden' })
    }
  })

  it('no role / unauthenticated → unauthorized', () => {
    expect(
      evaluateConnectorPickerAccess({
        role: null,
        actingAsClient: false,
        activeOrgId: null,
        stateOrgId: CLIENT,
      })
    ).toEqual({ ok: false, error: 'unauthorized' })
  })

  it('owner whose state happens to match is STILL forbidden (role checked before org)', () => {
    // Guards against a regression where an owner self-serve path sneaks back in.
    expect(
      evaluateConnectorPickerAccess({
        role: 'owner',
        actingAsClient: true,
        activeOrgId: CLIENT,
        stateOrgId: CLIENT,
      })
    ).toEqual({ ok: false, error: 'forbidden' })
  })
})
