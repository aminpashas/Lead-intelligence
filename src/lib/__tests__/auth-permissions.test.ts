import { describe, it, expect } from 'vitest'
import {
  hasPermission,
  isAdminRole,
  canManageTeam,
  canViewBilling,
  canAccessRoute,
  ROLE_PERMISSIONS,
  ROLE_LABELS,
  ROLE_COLORS,
  ASSIGNABLE_ROLES,
  type PracticeRole,
  type Permission,
} from '@/lib/auth/permissions'
import { isOrgAllowed, type ServiceAuth } from '@/lib/auth/service-key'

// ═══════════════════════════════════════════════════════════════
// Role Definitions
// ═══════════════════════════════════════════════════════════════

describe('Role definitions', () => {
  it('has a label for every role', () => {
    const allRoles: PracticeRole[] = [
      'doctor_admin', 'doctor', 'nurse', 'assistant',
      'treatment_coordinator', 'office_manager',
      'owner', 'admin', 'manager', 'member',
      'agency_admin',
    ]

    allRoles.forEach((role) => {
      expect(ROLE_LABELS[role]).toBeTruthy()
    })
  })

  it('has colors for every role', () => {
    const allRoles = Object.keys(ROLE_LABELS) as PracticeRole[]
    allRoles.forEach((role) => {
      expect(ROLE_COLORS[role]).toBeTruthy()
    })
  })

  it('ASSIGNABLE_ROLES contains only non-legacy practice roles', () => {
    expect(ASSIGNABLE_ROLES).toContain('doctor_admin')
    expect(ASSIGNABLE_ROLES).toContain('doctor')
    expect(ASSIGNABLE_ROLES).toContain('nurse')
    expect(ASSIGNABLE_ROLES).toContain('assistant')
    expect(ASSIGNABLE_ROLES).toContain('treatment_coordinator')
    expect(ASSIGNABLE_ROLES).toContain('office_manager')

    // Legacy roles should NOT be assignable
    expect(ASSIGNABLE_ROLES).not.toContain('owner')
    expect(ASSIGNABLE_ROLES).not.toContain('admin')
    expect(ASSIGNABLE_ROLES).not.toContain('manager')
    expect(ASSIGNABLE_ROLES).not.toContain('member')
    expect(ASSIGNABLE_ROLES).not.toContain('agency_admin')
  })
})

// ═══════════════════════════════════════════════════════════════
// hasPermission
// ═══════════════════════════════════════════════════════════════

describe('hasPermission', () => {
  // Admin roles have full permissions
  const fullAccessRoles: PracticeRole[] = ['doctor_admin', 'office_manager', 'owner', 'admin', 'agency_admin']

  fullAccessRoles.forEach((role) => {
    it(`${role} has all permissions`, () => {
      const permissions: Permission[] = [
        'dashboard:view', 'clinical:read', 'clinical:write',
        'leads:read', 'leads:write', 'billing:read', 'billing:write',
        'team:read', 'team:manage', 'settings:read', 'settings:write',
        'ai_control:read', 'ai_control:write',
        'cases:read', 'cases:create', 'cases:diagnose',
        'contracts:read', 'contracts:generate', 'contracts:approve', 'contracts:void',
        'contract_templates:manage', 'legal_settings:manage',
      ]

      permissions.forEach((perm) => {
        expect(hasPermission(role, perm)).toBe(true)
      })
    })
  })

  // Clinical roles have limited permissions
  const clinicalRoles: PracticeRole[] = ['nurse', 'assistant', 'member']

  clinicalRoles.forEach((role) => {
    it(`${role} can view dashboard and clinical data`, () => {
      expect(hasPermission(role, 'dashboard:view')).toBe(true)
      expect(hasPermission(role, 'clinical:read')).toBe(true)
      expect(hasPermission(role, 'clinical:write')).toBe(true)
      expect(hasPermission(role, 'schedule:read')).toBe(true)
    })

    it(`${role} cannot manage team or billing`, () => {
      expect(hasPermission(role, 'team:manage')).toBe(false)
      expect(hasPermission(role, 'billing:write')).toBe(false)
      expect(hasPermission(role, 'settings:write')).toBe(false)
    })

    it(`${role} cannot write to leads or campaigns`, () => {
      expect(hasPermission(role, 'leads:write')).toBe(false)
      expect(hasPermission(role, 'campaigns:write')).toBe(false)
    })
  })

  // Doctor-specific permissions
  it('doctor can diagnose cases and generate contracts', () => {
    expect(hasPermission('doctor', 'cases:diagnose')).toBe(true)
    expect(hasPermission('doctor', 'contracts:generate')).toBe(true)
  })

  it('doctor cannot approve or void contracts', () => {
    expect(hasPermission('doctor', 'contracts:approve')).toBe(false)
    expect(hasPermission('doctor', 'contracts:void')).toBe(false)
  })

  // Treatment coordinator permissions
  it('treatment_coordinator can manage leads, campaigns, and financing', () => {
    expect(hasPermission('treatment_coordinator', 'leads:write')).toBe(true)
    expect(hasPermission('treatment_coordinator', 'campaigns:read')).toBe(true)
    expect(hasPermission('treatment_coordinator', 'campaigns:write')).toBe(true)
    expect(hasPermission('treatment_coordinator', 'smart_lists:read')).toBe(true)
    expect(hasPermission('treatment_coordinator', 'mass_sms:write')).toBe(true)
    expect(hasPermission('treatment_coordinator', 'call_center:read')).toBe(true)
    expect(hasPermission('treatment_coordinator', 'funnel:write')).toBe(true)
  })

  it('treatment_coordinator can generate but not approve contracts', () => {
    expect(hasPermission('treatment_coordinator', 'contracts:generate')).toBe(true)
    expect(hasPermission('treatment_coordinator', 'contracts:approve')).toBe(false)
    expect(hasPermission('treatment_coordinator', 'contracts:void')).toBe(false)
  })

  // Legacy manager maps to TC permissions
  it('manager has same permissions as treatment_coordinator', () => {
    const tcPerms = ROLE_PERMISSIONS['treatment_coordinator']
    const mgrPerms = ROLE_PERMISSIONS['manager']
    expect(mgrPerms).toEqual(tcPerms)
  })

  // Invalid role
  it('returns false for unknown role', () => {
    expect(hasPermission('unknown_role', 'dashboard:view')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════
// isAdminRole
// ═══════════════════════════════════════════════════════════════

describe('isAdminRole', () => {
  it('identifies admin roles correctly', () => {
    expect(isAdminRole('doctor_admin')).toBe(true)
    expect(isAdminRole('office_manager')).toBe(true)
    expect(isAdminRole('owner')).toBe(true)
    expect(isAdminRole('admin')).toBe(true)
    expect(isAdminRole('agency_admin')).toBe(true)
  })

  it('non-admin roles return false', () => {
    expect(isAdminRole('doctor')).toBe(false)
    expect(isAdminRole('nurse')).toBe(false)
    expect(isAdminRole('assistant')).toBe(false)
    expect(isAdminRole('treatment_coordinator')).toBe(false)
    expect(isAdminRole('member')).toBe(false)
    expect(isAdminRole('manager')).toBe(false)
  })

  it('unknown role returns false', () => {
    expect(isAdminRole('intern')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════
// canManageTeam
// ═══════════════════════════════════════════════════════════════

describe('canManageTeam', () => {
  it('admin roles can manage team', () => {
    expect(canManageTeam('doctor_admin')).toBe(true)
    expect(canManageTeam('office_manager')).toBe(true)
    expect(canManageTeam('owner')).toBe(true)
    expect(canManageTeam('admin')).toBe(true)
    expect(canManageTeam('agency_admin')).toBe(true)
  })

  it('non-admin roles cannot manage team', () => {
    expect(canManageTeam('doctor')).toBe(false)
    expect(canManageTeam('nurse')).toBe(false)
    expect(canManageTeam('treatment_coordinator')).toBe(false)
    expect(canManageTeam('member')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════
// canViewBilling
// ═══════════════════════════════════════════════════════════════

describe('canViewBilling', () => {
  it('admin roles can view billing', () => {
    expect(canViewBilling('doctor_admin')).toBe(true)
    expect(canViewBilling('office_manager')).toBe(true)
    expect(canViewBilling('owner')).toBe(true)
  })

  it('non-admin roles cannot view billing', () => {
    expect(canViewBilling('doctor')).toBe(false)
    expect(canViewBilling('nurse')).toBe(false)
    expect(canViewBilling('treatment_coordinator')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════
// canAccessRoute
// ═══════════════════════════════════════════════════════════════

describe('canAccessRoute', () => {
  it('allows admin to access any route', () => {
    expect(canAccessRoute('doctor_admin', '/dashboard')).toBe(true)
    expect(canAccessRoute('doctor_admin', '/settings/billing')).toBe(true)
    expect(canAccessRoute('doctor_admin', '/settings/team')).toBe(true)
    expect(canAccessRoute('doctor_admin', '/settings/ai')).toBe(true)
    expect(canAccessRoute('doctor_admin', '/settings')).toBe(true)
    expect(canAccessRoute('doctor_admin', '/settings/legal')).toBe(true)
  })

  it('nurse can access clinical routes', () => {
    expect(canAccessRoute('nurse', '/dashboard')).toBe(true)
    expect(canAccessRoute('nurse', '/leads')).toBe(true)
    expect(canAccessRoute('nurse', '/conversations')).toBe(true)
    expect(canAccessRoute('nurse', '/appointments')).toBe(true)
    expect(canAccessRoute('nurse', '/cases')).toBe(true)
  })

  it('nurse cannot access admin routes', () => {
    expect(canAccessRoute('nurse', '/settings/billing')).toBe(false)
    expect(canAccessRoute('nurse', '/settings/team')).toBe(false)
    expect(canAccessRoute('nurse', '/settings/legal')).toBe(false)
  })

  it('handles prefix matching for nested routes', () => {
    expect(canAccessRoute('nurse', '/leads/lead-123')).toBe(true)
    expect(canAccessRoute('nurse', '/cases/case-456')).toBe(true)
    expect(canAccessRoute('nurse', '/settings/billing/invoices')).toBe(false)
  })

  it('resolves the most specific prefix (nested gate beats parent)', () => {
    // /settings itself is readable by clinical roles, but the connectors subtree
    // must stay agency-only even though it lives under /settings.
    expect(canAccessRoute('nurse', '/settings')).toBe(true)
    expect(canAccessRoute('nurse', '/settings/connectors/events')).toBe(false)
    expect(canAccessRoute('agency_admin', '/settings/connectors/events')).toBe(true)
  })

  it('gates the contract templates tab + its detail route', () => {
    expect(canAccessRoute('doctor_admin', '/settings/contracts/templates')).toBe(true)
    expect(canAccessRoute('doctor_admin', '/settings/contracts/templates/abc')).toBe(true)
    expect(canAccessRoute('nurse', '/settings/contracts/templates')).toBe(false)
  })

  it('allows access to unknown routes (safe fallback)', () => {
    expect(canAccessRoute('member', '/some/unknown/route')).toBe(true)
  })

  it('treatment_coordinator can access campaign + broadcast routes', () => {
    expect(canAccessRoute('treatment_coordinator', '/campaigns')).toBe(true)
    expect(canAccessRoute('treatment_coordinator', '/reactivation')).toBe(true)
    expect(canAccessRoute('treatment_coordinator', '/leads/lists')).toBe(true)
    expect(canAccessRoute('treatment_coordinator', '/call-center')).toBe(true)
    expect(canAccessRoute('treatment_coordinator', '/campaigns/playbook')).toBe(true)
    expect(canAccessRoute('treatment_coordinator', '/broadcasts/sms')).toBe(true)
    expect(canAccessRoute('treatment_coordinator', '/broadcasts/audit')).toBe(true)
  })

  it('nurse cannot broadcast', () => {
    expect(canAccessRoute('nurse', '/broadcasts/sms')).toBe(false)
    expect(canAccessRoute('nurse', '/leads/lists')).toBe(false)
  })

  it('treatment_coordinator cannot access billing or team management', () => {
    expect(canAccessRoute('treatment_coordinator', '/settings/billing')).toBe(false)
    expect(canAccessRoute('treatment_coordinator', '/settings/team')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════
// Agency-only capabilities (connectors + console)
// These must be exclusive to agency_admin — client owners/admins,
// even with "full" access, must never receive them.
// ═══════════════════════════════════════════════════════════════

describe('agency-only permissions', () => {
  it('agency_admin has connectors:manage and agency:console', () => {
    expect(hasPermission('agency_admin', 'connectors:manage')).toBe(true)
    expect(hasPermission('agency_admin', 'agency:console')).toBe(true)
  })

  it('no client role (even full-access) has the agency-only permissions', () => {
    const clientRoles: PracticeRole[] = [
      'doctor_admin', 'office_manager', 'owner', 'admin', 'manager',
      'doctor', 'nurse', 'assistant', 'treatment_coordinator', 'member',
    ]
    clientRoles.forEach((role) => {
      expect(hasPermission(role, 'connectors:manage')).toBe(false)
      expect(hasPermission(role, 'agency:console')).toBe(false)
    })
  })

  it('only agency_admin can access the connectors subtree', () => {
    expect(canAccessRoute('agency_admin', '/settings/connectors')).toBe(true)
    expect(canAccessRoute('agency_admin', '/settings/connectors/events')).toBe(true)
    expect(canAccessRoute('admin', '/settings/connectors')).toBe(false)
    expect(canAccessRoute('owner', '/settings/connectors')).toBe(false)
    expect(canAccessRoute('doctor_admin', '/settings/connectors/google/select')).toBe(false)
  })

  it('only agency_admin can access the agency console', () => {
    expect(canAccessRoute('agency_admin', '/agency')).toBe(true)
    expect(canAccessRoute('admin', '/agency')).toBe(false)
    expect(canAccessRoute('office_manager', '/agency')).toBe(false)
  })

  it('client admins can still reach /settings itself (only connectors is gated)', () => {
    expect(canAccessRoute('admin', '/settings')).toBe(true)
    expect(canAccessRoute('owner', '/settings')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════
// Service-key org allowlist (multi-tenant IDOR guard)
// A verified bridge caller may only act on its allowlisted org ids.
// ═══════════════════════════════════════════════════════════════

describe('isOrgAllowed (service-key org scoping)', () => {
  const ORG_A = '11111111-1111-1111-1111-111111111111'
  const ORG_B = '22222222-2222-2222-2222-222222222222'

  it('rejects a customer_id outside the allowlist', () => {
    const auth: ServiceAuth = { caller: 'growth-studio', allowedOrgIds: [ORG_A] }
    expect(isOrgAllowed(auth, ORG_B)).toBe(false)
  })

  it('allows a customer_id that is in the allowlist', () => {
    const auth: ServiceAuth = { caller: 'growth-studio', allowedOrgIds: [ORG_A, ORG_B] }
    expect(isOrgAllowed(auth, ORG_A)).toBe(true)
    expect(isOrgAllowed(auth, ORG_B)).toBe(true)
  })

  it('permits any org when unrestricted ("*")', () => {
    const auth: ServiceAuth = { caller: 'growth-studio', allowedOrgIds: '*' }
    expect(isOrgAllowed(auth, ORG_A)).toBe(true)
    expect(isOrgAllowed(auth, ORG_B)).toBe(true)
  })

  it('an empty allowlist rejects everything', () => {
    const auth: ServiceAuth = { caller: 'growth-studio', allowedOrgIds: [] }
    expect(isOrgAllowed(auth, ORG_A)).toBe(false)
  })
})
