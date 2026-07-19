import type { SupabaseClient } from '@supabase/supabase-js'
import type { TimelineRow, ActorType } from '@/lib/audit/types'
import { DERIVED_FIELDS } from '@/lib/audit/fields'
import { isUndoable } from '@/lib/audit/undo'
import { resolveActorNames, resolveResourceRefs, refKey } from '@/lib/audit/enrich'

export function normalizeTimeline(auditRows: any[], hipaaRows: any[]): TimelineRow[] {
  const a: TimelineRow[] = (auditRows ?? []).map((r) => {
    const changedFields = r.changed_fields ?? []
    return {
      id: r.id,
      occurredAt: r.occurred_at,
      actorType: r.actor_type as ActorType,
      actorLabel: r.actor_label ?? null,
      actorId: r.actor_id ?? null,
      actorName: null,
      action: r.action,
      resourceType: r.resource_type ?? null,
      resourceId: r.resource_id ?? null,
      resourceLabel: null,
      resourceHref: null,
      changedFields,
      ai: r.ai ?? null,
      severity: r.severity ?? 'info',
      origin: 'audit_events',
      undoable: isUndoable({
        action: r.action,
        resourceType: r.resource_type ?? null,
        resourceId: r.resource_id ?? null,
        changedFields,
      }),
    }
  })
  const h: TimelineRow[] = (hipaaRows ?? []).map((r) => ({
    id: r.id,
    occurredAt: r.created_at,
    actorType: r.actor_type as ActorType,
    actorLabel: r.actor_id ?? null,
    actorId: r.actor_id ?? null,
    actorName: null,
    action: r.event_type,
    resourceType: r.resource_type ?? null,
    resourceId: r.resource_id ?? null,
    resourceLabel: null,
    resourceHref: null,
    changedFields: [],
    ai: null,
    severity: r.severity ?? 'info',
    origin: 'hipaa_audit_log',
    // hipaa_audit_log records access, not field edits — nothing to revert.
    undoable: false,
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
  /**
   * Hide events whose only changes were system bookkeeping (~50% of the log).
   * Defaults to true — the raw feed is unreadable otherwise. Nothing is
   * deleted; this is a view filter over an append-only log.
   */
  materialOnly?: boolean
}

/**
 * PostgREST `or` predicate for the material-events filter.
 *
 * `changed_fields.not.cd.{…}` alone would drop rows where changed_fields IS
 * NULL — inserts, deletes and api_route events like sms.sent, which carry
 * their meaning in the action rather than a field diff. The explicit
 * `is.null` arm keeps them.
 */
export function materialOnlyFilter(): string {
  const derived = [...DERIVED_FIELDS].join(',')
  return `changed_fields.is.null,changed_fields.not.cd.{${derived}}`
}

/**
 * Attaches actor names and resource labels to a page of timeline rows.
 *
 * Two batched lookups total, independent of page size — never one query per
 * row. Mutates nothing: returns new row objects.
 */
export async function enrichTimeline(
  supabase: SupabaseClient,
  organizationId: string,
  rows: TimelineRow[]
): Promise<TimelineRow[]> {
  if (rows.length === 0) return rows

  const [actors, resources] = await Promise.all([
    resolveActorNames(
      supabase,
      rows.map((r) => r.actorId).filter((id): id is string => Boolean(id))
    ),
    resolveResourceRefs(supabase, organizationId, rows),
  ])

  return rows.map((row) => {
    const ref = refKey(row.resourceType, row.resourceId)
    const resource = ref ? resources.get(ref) : undefined
    return {
      ...row,
      // Prefer the freshly resolved name; fall back to whatever the writer
      // stamped on the event (AI agents supply a label but no user id). An
      // actor id that resolves to no profile (deleted staff, synthetic system
      // uuids) still names itself rather than rendering blank — "nobody" and
      // "someone we can't name" must not look the same in an audit log.
      actorName:
        (row.actorId ? actors.get(row.actorId) : null) ??
        row.actorLabel ??
        (row.actorId ? 'Unknown user' : null),
      resourceLabel: resource?.label ?? null,
      resourceHref: resource?.href ?? null,
    }
  })
}

export async function fetchAuditTimeline(
  supabase: SupabaseClient,
  organizationId: string,
  filter: AuditFilter = {}
): Promise<TimelineRow[]> {
  const limit = Math.min(filter.limit ?? 100, 500)
  let aq = supabase
    .from('audit_events')
    .select(
      'id,occurred_at,actor_type,actor_id,actor_label,action,resource_type,resource_id,changed_fields,ai,severity'
    )
    .eq('organization_id', organizationId)
    .order('occurred_at', { ascending: false })
    .limit(limit)
  if (filter.resourceType) aq = aq.eq('resource_type', filter.resourceType)
  if (filter.resourceId) aq = aq.eq('resource_id', filter.resourceId)
  if (filter.actorType) aq = aq.eq('actor_type', filter.actorType)
  if (filter.action) aq = aq.eq('action', filter.action)
  if (filter.since) aq = aq.gte('occurred_at', filter.since)
  if (filter.materialOnly !== false) aq = aq.or(materialOnlyFilter())

  let hq = supabase
    .from('hipaa_audit_log')
    .select('id,created_at,actor_type,actor_id,event_type,resource_type,resource_id,severity,description')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (filter.resourceType) hq = hq.eq('resource_type', filter.resourceType)
  if (filter.resourceId) hq = hq.eq('resource_id', filter.resourceId)

  const [{ data: audit }, { data: hipaa }] = await Promise.all([aq, hq])
  const rows = normalizeTimeline(audit ?? [], hipaa ?? []).slice(0, limit)
  return enrichTimeline(supabase, organizationId, rows)
}
