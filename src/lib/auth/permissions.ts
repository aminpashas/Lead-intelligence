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
  | 'bulk_actions:write'
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
  // Agency-only (deliberately NOT part of FULL_PERMISSIONS — client owners/admins
  // must never receive these; only agency_admin does)
  | 'connectors:manage'
  | 'agency:console'

// Full practice-side access for practice admin roles. Deliberately EXCLUDES
// agency-scale outbound (mass SMS/email, campaign/reactivation launches, bulk
// actions) and AI configuration: those stay with the agency (agency_admin) so
// a practice can never blast its own book or retune the AI. Practice admins
// keep full visibility (reads) plus 1:1 outreach via lead detail / call center.
const FULL_PERMISSIONS: Permission[] = [
  'dashboard:view',
  'clinical:read', 'clinical:write',
  'schedule:read', 'schedule:write',
  'leads:read', 'leads:write',
  'conversations:read', 'conversations:write',
  'pipeline:read', 'pipeline:write',
  'campaigns:read',
  'analytics:read',
  'billing:read', 'billing:write',
  'team:read', 'team:manage',
  'ai_control:read',
  'settings:read', 'settings:write',
  'smart_lists:read', 'smart_lists:write',
  'reactivation:read',
  'broadcast_audit:read',
  'call_center:read', 'call_center:write',
  'funnel:read',
  'cases:read', 'cases:create', 'cases:diagnose',
  'contracts:read', 'contracts:generate', 'contracts:approve', 'contracts:void',
  'contract_templates:manage', 'legal_settings:manage',
]

// Agency-scale outbound + AI configuration. Only agency_admin carries these;
// they are the enforcement half of the practice/agency split (SF Dentistry
// onboarding decision, 2026-07-03).
const AGENCY_OUTBOUND_PERMISSIONS: Permission[] = [
  'campaigns:write',
  'reactivation:write',
  'mass_sms:write', 'mass_email:write',
  'bulk_actions:write',
  'ai_control:write',
  'funnel:write',
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

// Treatment coordinator: clinical + lead working + contract generation.
// Campaign/reactivation visibility is read-only; launching anything at scale
// (broadcasts, campaign activation, bulk actions) is agency-side.
const TC_PERMISSIONS: Permission[] = [
  ...CLINICAL_PERMISSIONS,
  'leads:write',
  'pipeline:write',
  'campaigns:read',
  'smart_lists:read', 'smart_lists:write',
  'reactivation:read',
  'broadcast_audit:read',
  'funnel:read',
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
  // Agency admin gets everything PLUS the agency-only capabilities: mass
  // outbound / campaign launches / AI config (AGENCY_OUTBOUND_PERMISSIONS) and
  // the connector + console permissions. All of these are intentionally absent
  // from every practice role — they are what keep bulk outreach, AI tuning,
  // marketing connectors, and the agency console out of client staff's reach.
  agency_admin: [
    ...FULL_PERMISSIONS,
    ...AGENCY_OUTBOUND_PERMISSIONS,
    'connectors:manage',
    'agency:console',
  ],
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

/**
 * "Focused" front-desk staff: can view a lead but not work the book at scale
 * (leads:read without leads:write) — i.e., clinical-only roles (doctor, nurse,
 * assistant, member). These get the Today dashboard and a curated nav (no
 * pipeline kanban, no 45k-lead browse) — less overwhelm, smaller PII surface.
 * Capability-driven so new clinical roles inherit it automatically.
 */
export function isFocusedStaff(role: PracticeRole | string): boolean {
  return hasPermission(role, 'leads:read') && !hasPermission(role, 'leads:write')
}

/**
 * Which home dashboard a role sees:
 *  - 'agency'    → the AI command center (company control room). agency_admin.
 *  - 'frontdesk' → the Today view (consults, schedule, per-visit prep). Clinical
 *                  staff (see isFocusedStaff).
 *  - 'ops'       → the practice ops board (pipeline stages + funnel + booked
 *                  consults) without campaign/AI powers. Practice admins + TCs.
 */
export function dashboardVariant(
  role: PracticeRole | string
): 'agency' | 'ops' | 'frontdesk' {
  if (role === 'agency_admin') return 'agency'
  if (isFocusedStaff(role)) return 'frontdesk'
  return 'ops'
}

/**
 * Privilege ranking for "can actor act on target" decisions (deactivate / change
 * role). Higher wins. Used to stop a practice-level admin from deactivating the
 * practice owner or the overseeing agency_admin, and to protect the last admin.
 */
const ROLE_RANK: Record<PracticeRole, number> = {
  agency_admin: 100,
  owner: 90,
  doctor_admin: 80,
  admin: 80,
  office_manager: 70,
  manager: 50,
  doctor: 40,
  treatment_coordinator: 30,
  nurse: 20,
  assistant: 20,
  member: 10,
}

export function roleRank(role: PracticeRole | string): number {
  return ROLE_RANK[role as PracticeRole] ?? 0
}

/**
 * True if `actorRole` outranks `targetRole` and may therefore deactivate them or
 * change their role. Equal rank is NOT sufficient (an admin cannot act on a peer
 * admin), which keeps the agency_admin and owner out of practice-admin reach.
 */
export function canActOnRole(
  actorRole: PracticeRole | string,
  targetRole: PracticeRole | string,
): boolean {
  return roleRank(actorRole) > roleRank(targetRole)
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

/**
 * Map dashboard routes to the permission required to view them.
 *
 * Routes are consolidated into section hubs (see the sidebar + hub layouts):
 * Broadcasts (SMS/Email/Audit), Leads (+ Smart Lists), Campaigns (+ Funnel
 * Playbook), Analytics (+ Agent KPI), and Settings (Team/Billing/AI/Connectors/
 * Legal/Templates). canAccessRoute resolves the most specific matching prefix,
 * so a nested subtree gate (e.g. /settings/connectors) wins over its parent.
 */
const ROUTE_PERMISSION_MAP: Record<string, Permission> = {
  '/agency': 'agency:console',
  '/dashboard': 'dashboard:view',
  '/pipeline': 'pipeline:read',
  // Leads + Smart Lists
  '/leads': 'leads:read',
  '/leads/lists': 'smart_lists:read',
  '/conversations': 'conversations:read',
  '/call-center': 'call_center:read',
  '/dialer': 'call_center:read',
  '/appointments': 'schedule:read',
  // Campaigns + Funnel Playbook
  '/campaigns': 'campaigns:read',
  '/campaigns/playbook': 'funnel:read',
  // Campaigns hub — relocated Audiences (Smart Lists) + Broadcasts (Phase 1 move).
  // Explicit keys keep the original, stricter gates instead of inheriting
  // the looser /campaigns → campaigns:read via prefix match.
  '/campaigns/audiences': 'smart_lists:read',
  '/campaigns/broadcasts': 'mass_sms:write',
  '/campaigns/broadcasts/sms': 'mass_sms:write',
  '/campaigns/broadcasts/email': 'mass_email:write',
  '/campaigns/broadcasts/audit': 'broadcast_audit:read',
  '/reactivation': 'reactivation:read',
  // Broadcasts hub
  '/broadcasts': 'mass_sms:write',
  '/broadcasts/sms': 'mass_sms:write',
  '/broadcasts/email': 'mass_email:write',
  '/broadcasts/audit': 'broadcast_audit:read',
  // Revenue
  '/cases': 'cases:read',
  '/contracts': 'contracts:read',
  // Analytics + Agent KPI
  '/analytics': 'analytics:read',
  '/analytics/agents': 'analytics:read',
  // Universal action timeline (staff + AI). Reuses broadcast_audit:read, the
  // closest existing "view audit log" permission, rather than introducing a
  // new permission for a single route.
  '/audit': 'broadcast_audit:read',
  // Settings hub
  '/settings': 'settings:read',
  '/settings/team': 'team:manage',
  '/settings/billing': 'billing:read',
  '/settings/ai': 'ai_control:read',
  '/settings/connectors': 'connectors:manage',
  '/settings/legal': 'legal_settings:manage',
  // Key matches the real page + the Settings hub tab href. There is no
  // /settings/contracts index page, so pointing the key at .../templates keeps
  // the map from advertising a phantom route while still gating the [id] detail
  // via the longest-prefix scan.
  '/settings/contracts/templates': 'contract_templates:manage',
}

/** Check if a role can access a given route */
export function canAccessRoute(role: PracticeRole | string, pathname: string): boolean {
  // Exact match wins outright.
  const exactPermission = ROUTE_PERMISSION_MAP[pathname]
  if (exactPermission) {
    return hasPermission(role as PracticeRole, exactPermission)
  }

  // Prefix match, most-specific first, so a nested gate (e.g. /settings/connectors)
  // is checked before its looser parent (/settings). Without the length sort,
  // /settings/connectors/events could incorrectly resolve to settings:read.
  const bySpecificity = Object.entries(ROUTE_PERMISSION_MAP).sort(
    (a, b) => b[0].length - a[0].length
  )
  for (const [route, permission] of bySpecificity) {
    if (pathname.startsWith(route + '/')) {
      return hasPermission(role as PracticeRole, permission)
    }
  }

  // Default: allow access to unknown routes (safe fallback)
  return true
}
