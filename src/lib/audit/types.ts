export type ActorType = 'user' | 'system' | 'ai_agent' | 'cron' | 'webhook'
export type AuditSource = 'db_trigger' | 'api_route' | 'cron' | 'webhook'
export type AgentRole = 'setter' | 'closer' | 'autopilot' | 'voice'

export type AiContext = {
  model?: string
  agent_role?: AgentRole
  autonomous: boolean
  approved_by?: string | null
  gate?: string
  confidence?: number
}

export type AuditActor = {
  actorType: ActorType
  actorId?: string | null
  actorLabel?: string | null
  requestId?: string | null
}

export type AuditEventInput = {
  organizationId: string
  action: string
  actor: AuditActor
  source: AuditSource
  resourceType?: string | null
  resourceId?: string | null
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  changedFields?: string[] | null
  ai?: AiContext | null
  severity?: 'info' | 'warning' | 'critical'
  metadata?: Record<string, unknown>
}

export type TimelineRow = {
  id: string
  occurredAt: string
  actorType: ActorType
  /** Name recorded ON the event at write time, when the writer supplied one. */
  actorLabel: string | null
  /** auth.uid() of the acting user, when the write happened in a user session. */
  actorId: string | null
  /**
   * Actor name resolved from user_profiles at READ time. Preferred over
   * actorLabel for display: the log stores ids so a renamed user renders
   * correctly rather than showing a stale copy of their old name.
   */
  actorName: string | null
  action: string
  resourceType: string | null
  resourceId: string | null
  /** Human label for the touched record, e.g. the lead's name. */
  resourceLabel: string | null
  /** In-app link to that record, when one exists. */
  resourceHref: string | null
  changedFields: string[]
  ai: AiContext | null
  severity: string
  origin: 'audit_events' | 'hipaa_audit_log'
  /**
   * Whether an Undo button should render. A cheap pre-check — the
   * authoritative decision is made server-side on click (see lib/audit/undo).
   */
  undoable: boolean
}
