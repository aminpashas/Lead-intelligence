import type { SupabaseClient } from '@supabase/supabase-js'
import type { TimelineRow, ActorType } from '@/lib/audit/types'

export function normalizeTimeline(auditRows: any[], hipaaRows: any[]): TimelineRow[] {
  const a: TimelineRow[] = (auditRows ?? []).map((r) => ({
    id: r.id,
    occurredAt: r.occurred_at,
    actorType: r.actor_type as ActorType,
    actorLabel: r.actor_label ?? null,
    action: r.action,
    resourceType: r.resource_type ?? null,
    resourceId: r.resource_id ?? null,
    changedFields: r.changed_fields ?? [],
    ai: r.ai ?? null,
    severity: r.severity ?? 'info',
    origin: 'audit_events',
  }))
  const h: TimelineRow[] = (hipaaRows ?? []).map((r) => ({
    id: r.id,
    occurredAt: r.created_at,
    actorType: r.actor_type as ActorType,
    actorLabel: r.actor_id ?? null,
    action: r.event_type,
    resourceType: r.resource_type ?? null,
    resourceId: r.resource_id ?? null,
    changedFields: [],
    ai: null,
    severity: r.severity ?? 'info',
    origin: 'hipaa_audit_log',
  }))
  return [...a, ...h].sort((x, y) => (x.occurredAt < y.occurredAt ? 1 : -1))
}

export type AuditFilter = {
  resourceType?: string
  resourceId?: string
  actorType?: ActorType
  action?: string
  since?: string
  limit?: number
}

export async function fetchAuditTimeline(
  supabase: SupabaseClient,
  organizationId: string,
  filter: AuditFilter = {}
): Promise<TimelineRow[]> {
  const limit = Math.min(filter.limit ?? 100, 500)
  let aq = supabase
    .from('audit_events')
    .select('id,occurred_at,actor_type,actor_label,action,resource_type,resource_id,changed_fields,ai,severity')
    .eq('organization_id', organizationId)
    .order('occurred_at', { ascending: false })
    .limit(limit)
  if (filter.resourceType) aq = aq.eq('resource_type', filter.resourceType)
  if (filter.resourceId) aq = aq.eq('resource_id', filter.resourceId)
  if (filter.actorType) aq = aq.eq('actor_type', filter.actorType)
  if (filter.action) aq = aq.eq('action', filter.action)
  if (filter.since) aq = aq.gte('occurred_at', filter.since)

  let hq = supabase
    .from('hipaa_audit_log')
    .select('id,created_at,actor_type,actor_id,event_type,resource_type,resource_id,severity,description')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (filter.resourceType) hq = hq.eq('resource_type', filter.resourceType)
  if (filter.resourceId) hq = hq.eq('resource_id', filter.resourceId)

  const [{ data: audit }, { data: hipaa }] = await Promise.all([aq, hq])
  return normalizeTimeline(audit ?? [], hipaa ?? []).slice(0, limit)
}
