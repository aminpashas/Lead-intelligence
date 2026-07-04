import type { SupabaseClient } from '@supabase/supabase-js'
import type { AuditActor } from '@/lib/audit/types'

export function buildActorGucArgs(actor: AuditActor): { key: string; value: string }[] {
  const pairs: { key: string; value: string }[] = [
    { key: 'app.actor_type', value: actor.actorType },
  ]
  if (actor.actorId) pairs.push({ key: 'app.actor_id', value: actor.actorId })
  if (actor.actorLabel) pairs.push({ key: 'app.actor_label', value: actor.actorLabel })
  if (actor.requestId) pairs.push({ key: 'app.request_id', value: actor.requestId })
  return pairs
}

/**
 * Sets Postgres session GUCs so audit triggers can attribute writes made
 * through this client to the given actor. Call once per request before
 * performing audited mutations.
 */
export async function withAuditActor(client: SupabaseClient, actor: AuditActor): Promise<void> {
  for (const { key, value } of buildActorGucArgs(actor)) {
    await client.rpc('set_audit_config', { setting_key: key, setting_value: value })
  }
}
