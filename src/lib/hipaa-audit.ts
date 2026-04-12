/**
 * HIPAA Audit Logging Utilities
 *
 * Lightweight wrappers around logHIPAAEvent for common access patterns.
 * All PHI access must be logged per HIPAA Security Rule §164.312(b).
 *
 * IMPORTANT: Audit logging failures are logged to console.error as a fallback.
 * In production, these console errors should be routed to an alerting system
 * (e.g., Sentry, Datadog) to ensure no PHI access goes unrecorded.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logHIPAAEvent, type PHICategory } from '@/lib/ai/hipaa'

type AuditContext = {
  supabase: SupabaseClient
  organizationId: string
  actorId?: string
  actorType?: 'user' | 'system' | 'ai_agent' | 'cron' | 'webhook'
}

/**
 * Fallback handler for audit logging failures.
 * Ensures that failed audit events are still visible in logs
 * per HIPAA §164.312(b) requirements.
 */
function handleAuditFailure(eventType: string, resourceType: string, resourceId: string, error: unknown): void {
  console.error(
    `[HIPAA_AUDIT_FAILURE] Failed to log ${eventType} for ${resourceType}:${resourceId}. ` +
    `This is a HIPAA compliance concern. Error: ${error instanceof Error ? error.message : String(error)}`
  )
}

/**
 * Log PHI read access (viewing lead details, listing leads, reading messages).
 */
export async function auditPHIRead(
  ctx: AuditContext,
  resourceType: string,
  resourceId: string,
  description: string,
  phiCategories: PHICategory[] = ['name', 'phone', 'email']
): Promise<void> {
  await logHIPAAEvent(ctx.supabase, {
    organization_id: ctx.organizationId,
    event_type: 'phi_access',
    severity: 'info',
    actor_type: ctx.actorType || 'user',
    actor_id: ctx.actorId,
    resource_type: resourceType,
    resource_id: resourceId,
    description,
    phi_categories: phiCategories,
  }).catch((err) => {
    handleAuditFailure('phi_access', resourceType, resourceId, err)
  })
}

/**
 * Log PHI write/creation (creating or updating leads with PII).
 */
export async function auditPHIWrite(
  ctx: AuditContext,
  resourceType: string,
  resourceId: string,
  description: string,
  phiCategories: PHICategory[] = ['name', 'phone', 'email']
): Promise<void> {
  await logHIPAAEvent(ctx.supabase, {
    organization_id: ctx.organizationId,
    event_type: 'phi_stored',
    severity: 'info',
    actor_type: ctx.actorType || 'user',
    actor_id: ctx.actorId,
    resource_type: resourceType,
    resource_id: resourceId,
    description,
    phi_categories: phiCategories,
  }).catch((err) => {
    handleAuditFailure('phi_stored', resourceType, resourceId, err)
  })
}

/**
 * Log PHI deletion.
 */
export async function auditPHIDeletion(
  ctx: AuditContext,
  resourceType: string,
  resourceId: string,
  description: string
): Promise<void> {
  await logHIPAAEvent(ctx.supabase, {
    organization_id: ctx.organizationId,
    event_type: 'phi_deleted',
    severity: 'warning',
    actor_type: ctx.actorType || 'user',
    actor_id: ctx.actorId,
    resource_type: resourceType,
    resource_id: resourceId,
    description,
    phi_categories: ['name', 'phone', 'email', 'medical_record', 'financial', 'insurance_id'],
  }).catch((err) => {
    handleAuditFailure('phi_deleted', resourceType, resourceId, err)
  })
}

/**
 * Log PHI transmission to external service (Twilio, Resend, AI).
 */
export async function auditPHITransmission(
  ctx: AuditContext,
  resourceType: string,
  resourceId: string,
  destination: string,
  phiCategories: PHICategory[] = ['phone']
): Promise<void> {
  await logHIPAAEvent(ctx.supabase, {
    organization_id: ctx.organizationId,
    event_type: 'phi_transmitted',
    severity: 'info',
    actor_type: ctx.actorType || 'system',
    actor_id: ctx.actorId,
    resource_type: resourceType,
    resource_id: resourceId,
    description: `PHI transmitted to ${destination}`,
    phi_categories: phiCategories,
  }).catch((err) => {
    handleAuditFailure('phi_transmitted', resourceType, resourceId, err)
  })
}
