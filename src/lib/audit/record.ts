import type { SupabaseClient } from '@supabase/supabase-js'
import type { AuditEventInput } from '@/lib/audit/types'

export function buildAuditRow(event: AuditEventInput) {
  return {
    organization_id: event.organizationId,
    action: event.action,
    actor_type: event.actor.actorType,
    actor_id: event.actor.actorId ?? null,
    actor_label: event.actor.actorLabel ?? null,
    source: event.source,
    resource_type: event.resourceType ?? null,
    resource_id: event.resourceId ?? null,
    before: event.before ?? null,
    after: event.after ?? null,
    changed_fields: event.changedFields ?? null,
    ai: event.ai ?? null,
    request_id: event.actor.requestId ?? null,
    severity: event.severity ?? 'info',
    metadata: event.metadata ?? {},
  }
}

/**
 * Records an audit event. NEVER throws into the caller — a failure to audit
 * must not break the business action.
 */
export async function recordAudit(supabase: SupabaseClient, event: AuditEventInput): Promise<void> {
  try {
    const { error } = await supabase.from('audit_events').insert(buildAuditRow(event))
    if (error) throw error
  } catch (err) {
    console.error(
      `[AUDIT_FAILURE] Failed to record ${event.action} for ` +
      `${event.resourceType ?? '?'}:${event.resourceId ?? '?'}. ` +
      `Error: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
