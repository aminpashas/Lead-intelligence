'use client'

import { useOrgStore } from '@/lib/store/use-org'
import { hasPermission, isAdminRole, type Permission, type PracticeRole } from '@/lib/auth/permissions'
import { ShieldAlert } from 'lucide-react'

interface RoleGuardProps {
  /** The permission required to view the content */
  requiredPermission?: Permission
  /** Alternatively, require the user to be in the admin group */
  requireAdmin?: boolean
  /** Custom fallback UI when access is denied */
  fallback?: React.ReactNode
  /** Children to render when access is granted */
  children: React.ReactNode
}

/**
 * RoleGuard — Reusable role-based access control wrapper.
 *
 * Usage:
 *   <RoleGuard requiredPermission="billing:read">
 *     <BillingDashboard />
 *   </RoleGuard>
 *
 *   <RoleGuard requireAdmin>
 *     <TeamManagement />
 *   </RoleGuard>
 */
export function RoleGuard({
  requiredPermission,
  requireAdmin = false,
  fallback,
  children,
}: RoleGuardProps) {
  const { userProfile } = useOrgStore()
  const role = (userProfile?.role || 'member') as PracticeRole

  let allowed = true

  if (requireAdmin) {
    allowed = isAdminRole(role)
  }

  if (requiredPermission) {
    allowed = hasPermission(role, requiredPermission)
  }

  if (!allowed) {
    return fallback || <AccessDenied />
  }

  return <>{children}</>
}

function AccessDenied() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
      <div className="relative mb-6">
        <div className="absolute inset-0 rounded-full bg-destructive/10 blur-xl scale-150" />
        <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-destructive/10 border border-destructive/20">
          <ShieldAlert className="h-10 w-10 text-destructive" />
        </div>
      </div>
      <h2 className="text-2xl font-bold mb-2">Access Restricted</h2>
      <p className="text-muted-foreground max-w-md">
        You don&apos;t have permission to view this page. Please contact your practice administrator
        if you believe this is an error.
      </p>
    </div>
  )
}
