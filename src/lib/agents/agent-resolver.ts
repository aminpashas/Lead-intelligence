import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Resolve the agent_id for an org + role pair. Memoized in process
 * memory (5 min TTL) so the hot path for every AI message insert
 * pays at most one DB query per (org, role) per process window.
 *
 * Seeded agents exist for every org via migration 030 + the
 * seed_default_agents_for_org trigger, so a miss is rare. Returns
 * null if no matching agent row exists so callers can insert
 * messages with agent_id=null rather than failing.
 */

type AgentRole = 'setter' | 'closer'
type CacheEntry = { id: string | null; expiresAt: number }

const CACHE = new Map<string, CacheEntry>()
const TTL_MS = 5 * 60 * 1000

function cacheKey(orgId: string, role: AgentRole): string {
  return `${orgId}:${role}`
}

export async function getAgentIdForRole(
  supabase: SupabaseClient,
  orgId: string,
  role: AgentRole | string
): Promise<string | null> {
  if (role !== 'setter' && role !== 'closer') return null

  const key = cacheKey(orgId, role)
  const cached = CACHE.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.id

  const { data } = await supabase
    .from('ai_agents')
    .select('id')
    .eq('organization_id', orgId)
    .eq('role', role)
    .eq('is_active', true)
    .maybeSingle()

  const id = (data?.id as string | undefined) ?? null
  CACHE.set(key, { id, expiresAt: Date.now() + TTL_MS })
  return id
}

/** Test-only: flush the resolver cache. */
export function __clearAgentResolverCache(): void {
  CACHE.clear()
}
