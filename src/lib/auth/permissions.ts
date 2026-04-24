/**
 * Aurea Health — Role-Based Access Control (RBAC) Permissions Module
 *
 * Defines healthcare-specific roles, their permissions, and route-level access.
 * This is the single source of truth for all client-side authorization logic.
 */

// ── Role Definitions ────────────────────────────────────────────

export type PracticeRole =
  | 'doctor_admin'
  | 'doctor'
  | 'nurse'
  | 'assistant'
  | 'treatment_coordinator'
  | 'office_manager'
  // Legacy roles (backward-compat)
  | 'owner'
  | 'admin'
  | 'manager'
  | 'member'
  // Agency
  | 'agency_admin'

export const ROLE_LABELS: Record<PracticeRole, string> = {
  doctor_admin: 'Doctor (Admin)',
  doctor: 'Doctor',
  nurse: 'Nurse',
  assistant: 'Assistant',
  treatment_coordinator: 'Treatment Coordinator',
  office_manager: 'Office Manager',
  owner: 'Owner',
  admin: 'Admin',
  manager: 'Manager',
  member: 'Member',
  agency_admin: 'Agency Admin',
}

export const ROLE_COLORS: Record<PracticeRole, string> = {
  doctor_admin: 'bg-violet-500/15 text-violet-700 dark:text-violet-400 border-violet-500/25',
  doctor: 'bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/25',
  nurse: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/25',
  assistant: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/25',
  treatment_coordinator: 'bg-pink-500/15 text-pink-700 dark:text-pink-400 border-pink-500/25',
  office_manager: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 border-indigo-500/25',
  owner: 'bg-violet-500/15 text-violet-700 dark:text-violet-400 border-violet-500/25',
  admin: 'bg-violet-500/15 text-violet-700 dark:text-violet-400 border-violet-500/25',
  manager: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 border-indigo-500/25',
  member: 'bg-slate-500/15 text-slate-700 dark:text-slate-400 border-slate-500/25',
  agency_admin: 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/25',
}

/** Roles that can be assigned when inviting new team members */
export const ASSIGNABLE_ROLES: PracticeRole[] = [
  'doctor_admin',
  'doctor',
  'nurse',
  'assistant',
  'treatment_coordinator',
  'office_manager',
]

// ── Permission Definitions ──────────────────────────────────────

export type Permission =
  | 'dashboard:view'
  | 'clinical:read'
  | 'clinical:write'
  | 'schedule:read'
  | 'schedule:write'
  | 'leads:read'
  | 'leads:write'
  | 'conversations:read'
  | 'conversations:write'
  | 'pipeline:read'
  | 'pipeline:write'
  | 'campaigns:read'
  | 'campaigns:write'
  | 'analytics:read'
  | 'billing:read'
  | 'billing:write'
  | 'team:read'
  | 'team:manage'
  | 'ai_control:read'
  | 'ai_control:write'
  | 'settings:read'
  | 'settings:write'
  | 'smart_lists:read'
  | 'smart_lists:write'
  | 'reactivation:read'
  | 'reactivation:write'
  | 'mass_sms:write'
  | 'mass_email:write'
  | 'broadcast_audit:read'
  | 'call_center:read'
  | 'call_center:write'
  | 'funnel:read'
  | 'funnel:write'
  | 'cases:read'
  | 'cases:create'
  | 'cases:diagnose'
  | 'contracts:read'
  | 'contracts:generate'
  | 'contracts:approve'
  | 'contracts:void'
  | 'contract_templates:manage'
  | 'legal_settings:manage'

// Full access set for admin roles
const FULL_PERMISSIONS: Permission[] = [
  'dashboard:view',
  'clinical:read', 'clinical:write',
  'schedule:read', 'schedule:write',
  'leads:read', 'leads:write',
  'conversations:read', 'conversations:write',
  'pipeline:read', 'pipeline:write',
  'campaigns:read', 'campaigns:write',
  'analytics:read',
  'billing:read', 'billing:write',
  'team:read', 'team:manage',
  'ai_control:read', 'ai_control:write',
  'settings:read', 'settings:write',
  'smart_lists:read', 'smart_lists:write',
  'reactivation:read', 'reactivation:write',
  'mass_sms:write', 'mass_email:write',
  'broadcast_audit:read',
  'call_center:read', 'call_center:write',
  'funnel:read', 'funnel:write',
  'cases:read', 'cases:create', 'cases:diagnose',
  'contracts:read', 'contracts:generate', 'contracts:approve', 'contracts:void',
  'contract_templates:manage', 'legal_settings:manage',
]

// Clinical-only permissions
const CLINICAL_PERMISSIONS: Permission[] = [
  'dashboard:view',
  'clinical:read', 'clinical:write',
  'schedule:read', 'schedule:write',
  'leads:read',
  'conversations:read', 'conversations:write',
  'pipeline:read',
  'settings:read',
  'cases:read', 'cases:create',
  'contracts:read',
]

// Doctor permissions: clinical + diagnose + contract generation (no final approval)
const DOCTOR_PERMISSIONS: Permission[] = [
  ...CLINICAL_PERMISSIONS,
  'cases:diagnose',
  'contracts:generate',
]

// Treatment coordinator: clinical + marketing + contract generation
const TC_PERMISSIONS: Permission[] = [
  ...CLINICAL_PERMISSIONS,
  'leads:write',
  'pipeline:write',
  'campaigns:read', 'campaigns:write',
  'smart_lists:read', 'smart_lists:write',
  'reactivation:read', 'reactivation:write',
  'mass_sms:write', 'mass_email:write',
  'broadcast_audit:read',
  'funnel:read', 'funnel:write',
  'call_center:read', 'call_center:write',
  'contracts:generate',
]

/** Map of role → permissions */
export const ROLE_PERMISSIONS: Record<PracticeRole, Permission[]> = {
  doctor_admin: FULL_PERMISSIONS,
  office_manager: FULL_PERMISSIONS,
  doctor: DOCTOR_PERMISSIONS,
  nurse: CLINICAL_PERMISSIONS,
  assistant: CLINICAL_PERMISSIONS,
  treatment_coordinator: TC_PERMISSIONS,
  // Legacy roles mapped to closest equivalent
  owner: FULL_PERMISSIONS,
  admin: FULL_PERMISSIONS,
  manager: TC_PERMISSIONS,
  member: CLINICAL_PERMISSIONS,
  // Agency admin gets everything
  agency_admin: FULL_PERMISSIONS,
}

// ── Permission Utilities ────────────────────────────────────────

/** Check if a role has a specific permission */
export function hasPermission(role: PracticeRole | string, permission: Permission): boolean {
  const perms = ROLE_PERMISSIONS[role as PracticeRole]
  if (!perms) return false
  return perms.includes(permission)
}

/** Check if a role is in the admin group */
export function isAdminRole(role: PracticeRole | string): boolean {
  return ['doctor_admin', 'office_manager', 'owner', 'admin', 'agency_admin'].includes(role)
}

/** Check if a role can manage the team */
export function canManageTeam(role: PracticeRole | string): boolean {
  return hasPermission(role as PracticeRole, 'team:manage')
}

/** Check if a role can view billing */
export function canViewBilling(role: PracticeRole | string): boolean {
  return hasPermission(role as PracticeRole, 'billing:read')
}

// ── Route → Permission Mapping ──────────────────────────────────

/** Map dashboard routes to the permission required to view them */
const ROUTE_PERMISSION_MAP: Record<string, Permission> = {
  '/dashboard': 'dashboard:view',
  '/pipeline': 'pipeline:read',
  '/funnel': 'funnel:read',
  '/leads': 'leads:read',
  '/conversations': 'conversations:read',
  '/call-center': 'call_center:read',
  '/campaigns': 'campaigns:read',
  '/reactivation': 'reactivation:read',
  '/smart-lists': 'smart_lists:read',
  '/mass-sms': 'mass_sms:write',
  '/mass-email': 'mass_email:write',
  '/broadcast-audit': 'broadcast_audit:read',
  '/appointments': 'schedule:read',
  '/analytics': 'analytics:read',
  '/ai-control': 'ai_control:read',
  '/settings': 'settings:read',
  '/team': 'team:manage',
  '/billing': 'billing:read',
  '/cases': 'cases:read',
  '/contracts': 'contracts:read',
  '/settings/legal': 'legal_settings:manage',
  '/settings/contracts': 'contract_templates:manage',
}

/** Check if a role can access a given route */
export function canAccessRoute(role: PracticeRole | string, pathname: string): boolean {
  // Find the matching route (check exact match, then prefix match)
  const exactPermission = ROUTE_PERMISSION_MAP[pathname]
  if (exactPermission) {
    return hasPermission(role as PracticeRole, exactPermission)
  }

  // Prefix match (e.g., /leads/123 should check /leads permission)
  for (const [route, permission] of Object.entries(ROUTE_PERMISSION_MAP)) {
    if (pathname.startsWith(route + '/')) {
      return hasPermission(role as PracticeRole, permission)
    }
  }

  // Default: allow access to unknown routes (safe fallback)
  return true
}
