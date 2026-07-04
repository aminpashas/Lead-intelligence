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
  actorLabel: string | null
  action: string
  resourceType: string | null
  resourceId: string | null
  changedFields: string[]
  ai: AiContext | null
  severity: string
  origin: 'audit_events' | 'hipaa_audit_log'
}
