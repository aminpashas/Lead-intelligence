import { describe, it, expect } from 'vitest'
import {
  resolveAgencyLevel,
  agencyCan,
  AGENCY_CAPABILITIES,
  ASSIGNABLE_AGENCY_LEVELS,
  isAgencyRole,
  type AgencyCapability,
} from '@/lib/auth/permissions'

describe('resolveAgencyLevel', () => {
  it('treats a legacy agency_admin with no level as owner (backward compat)', () => {
    expect(resolveAgencyLevel('agency_admin', null)).toBe('owner')
    expect(resolveAgencyLevel('agency_admin', undefined)).toBe('owner')
    expect(resolveAgencyLevel('agency_admin', '')).toBe('owner')
  })

  it('honors an explicit agency level', () => {
    expect(resolveAgencyLevel('agency_admin', 'owner')).toBe('owner')
    expect(resolveAgencyLevel('agency_admin', 'manager')).toBe('manager')
    expect(resolveAgencyLevel('agency_admin', 'analyst')).toBe('analyst')
  })

  it('returns null for non-agency roles regardless of stored level', () => {
    expect(resolveAgencyLevel('doctor_admin', 'owner')).toBeNull()
    expect(resolveAgencyLevel('office_manager', 'manager')).toBeNull()
    expect(resolveAgencyLevel('member', null)).toBeNull()
  })

  it('falls back to owner when the stored level is unrecognized', () => {
    expect(resolveAgencyLevel('agency_admin', 'superuser')).toBe('owner')
  })
})

describe('agencyCan — capability matrix', () => {
  it('owner has every capability', () => {
    const all = new Set<AgencyCapability>(AGENCY_CAPABILITIES.owner)
    // Owner is the superset — its list must contain manager + analyst caps.
    for (const cap of AGENCY_CAPABILITIES.manager) expect(all.has(cap)).toBe(true)
    for (const cap of AGENCY_CAPABILITIES.analyst) expect(all.has(cap)).toBe(true)
    expect(agencyCan('owner', 'agency:team_manage')).toBe(true)
    expect(agencyCan('owner', 'agency:billing_manage')).toBe(true)
    expect(agencyCan('owner', 'agency:ai_config')).toBe(true)
  })

  it('manager can operate practices + client teams but not agency config', () => {
    expect(agencyCan('manager', 'agency:practices_write')).toBe(true)
    expect(agencyCan('manager', 'agency:client_team_manage')).toBe(true)
    expect(agencyCan('manager', 'agency:enter_account')).toBe(true)
    expect(agencyCan('manager', 'agency:integrations_manage')).toBe(true)
    // Denied: agency-level config + team management
    expect(agencyCan('manager', 'agency:team_manage')).toBe(false)
    expect(agencyCan('manager', 'agency:billing_manage')).toBe(false)
    expect(agencyCan('manager', 'agency:pricing_manage')).toBe(false)
    expect(agencyCan('manager', 'agency:ai_config')).toBe(false)
    expect(agencyCan('manager', 'agency:enterprises_manage')).toBe(false)
  })

  it('analyst is read-only', () => {
    expect(agencyCan('analyst', 'agency:practices_read')).toBe(true)
    expect(agencyCan('analyst', 'agency:spend_read')).toBe(true)
    expect(agencyCan('analyst', 'agency:analytics_read')).toBe(true)
    // No writes at all
    expect(agencyCan('analyst', 'agency:practices_write')).toBe(false)
    expect(agencyCan('analyst', 'agency:client_team_manage')).toBe(false)
    expect(agencyCan('analyst', 'agency:enter_account')).toBe(false)
    expect(agencyCan('analyst', 'agency:team_manage')).toBe(false)
  })

  it('null level (non-agency) can do nothing', () => {
    expect(agencyCan(null, 'agency:practices_read')).toBe(false)
    expect(agencyCan(null, 'agency:spend_read')).toBe(false)
  })
})

describe('helpers', () => {
  it('ASSIGNABLE_AGENCY_LEVELS covers all three tiers', () => {
    expect(ASSIGNABLE_AGENCY_LEVELS).toEqual(['owner', 'manager', 'analyst'])
  })

  it('isAgencyRole is true only for agency_admin', () => {
    expect(isAgencyRole('agency_admin')).toBe(true)
    expect(isAgencyRole('doctor_admin')).toBe(false)
    expect(isAgencyRole('owner')).toBe(false)
  })
})
