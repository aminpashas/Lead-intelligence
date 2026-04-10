/**
 * HIPAA Audit Logging Utilities
 *
 * Lightweight wrappers around logHIPAAEvent for common access patterns.
 * All PHI access must be logged per HIPAA Security Rule §164.312(b).
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
  }).catch(() => {
    // Audit logging failure should not break the request
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
  }).catch(() => {})
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
  }).catch(() => {})
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
  }).catch(() => {})
}
