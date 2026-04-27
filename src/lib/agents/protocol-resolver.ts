/**
 * Protocol resolver: fetch the active agent_protocols row for an
 * (org, role) pair with a 5-minute in-process cache.
 *
 * Behavior is opt-in by design:
 *   - If no active protocol exists OR `prompt_override` is null,
 *     returns null. The caller (setter/closer agent) keeps using
 *     its existing hardcoded prompt.
 *   - If an active protocol with a non-null `prompt_override` is
 *     found, the caller appends/replaces the system prompt with it.
 *
 * Migration 034 seeds an inactive v1 protocol per agent with
 * prompt_override=null, so default behavior is unchanged. Admins
 * (or the discipline engine, when auto_tune_enabled=true) flip
 * is_active=true on a protocol with content to take effect.
 *
 * Phase C of the AI Agent KPI Dashboard system.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

type AgentRole = 'setter' | 'closer'

export type ActiveProtocol = {
  id: string
  agent_id: string
  version: number
  name: string
  prompt_override: string | null
  outreach_templates: Record<string, unknown>
  cadence_config: Record<string, unknown>
  channel_rules: Record<string, unknown>
}

type CacheEntry = { protocol: ActiveProtocol | null; expiresAt: number }

const CACHE = new Map<string, CacheEntry>()
const TTL_MS = 5 * 60 * 1000

function cacheKey(orgId: string, role: AgentRole): string {
  return `${orgId}:${role}`
}

/**
 * Fetch the active protocol for an org's setter or closer agent.
 * Returns null when no active protocol exists — caller should
 * fall back to its hardcoded prompt.
 */
export async function getActiveProtocol(
  supabase: SupabaseClient,
  orgId: string,
  role: AgentRole | string
): Promise<ActiveProtocol | null> {
  if (role !== 'setter' && role !== 'closer') return null

  const key = cacheKey(orgId, role)
  const cached = CACHE.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.protocol

  const { data, error } = await supabase
    .from('agent_protocols')
    .select('id, agent_id, version, name, prompt_override, outreach_templates, cadence_config, channel_rules, ai_agents!inner(role, organization_id, is_active)')
    .eq('is_active', true)
    .eq('ai_agents.organization_id', orgId)
    .eq('ai_agents.role', role)
    .eq('ai_agents.is_active', true)
    .maybeSingle()

  if (error) {
    // Don't blow up the AI send path on a resolver error — fail open
    // to the hardcoded prompt and cache a null briefly so we don't
    // hammer the DB with retries.
    CACHE.set(key, { protocol: null, expiresAt: Date.now() + 60_000 })
    return null
  }

  const protocol: ActiveProtocol | null = data
    ? {
        id: data.id,
        agent_id: data.agent_id,
        version: data.version,
        name: data.name,
        prompt_override: data.prompt_override,
        outreach_templates: data.outreach_templates ?? {},
        cadence_config: data.cadence_config ?? {},
        channel_rules: data.channel_rules ?? {},
      }
    : null

  CACHE.set(key, { protocol, expiresAt: Date.now() + TTL_MS })
  return protocol
}

/**
 * Apply a protocol's prompt override to a baseline system prompt.
 *
 * Strategy: protocols are additive. The hardcoded prompt is always
 * the foundation (it carries skill orchestration, tool descriptions,
 * etc.); the override is appended as a "PROTOCOL OVERRIDE" section.
 * This keeps the agent's core behavior intact while letting admins
 * inject style, opener, or persona guidance.
 *
 * Pass `mode: 'replace'` only when the protocol fully replaces the
 * baseline — used by A/B test variants where the alternate prompt
 * is self-contained.
 */
export function composeSystemPrompt(
  baseline: string,
  protocol: ActiveProtocol | null,
  mode: 'append' | 'replace' = 'append'
): string {
  if (!protocol?.prompt_override) return baseline
  if (mode === 'replace') return protocol.prompt_override

  return `${baseline}

═══ PROTOCOL OVERRIDE (${protocol.name}, v${protocol.version}) ═══
${protocol.prompt_override}
═══════════════════════════════════════════════════`
}

/** Test-only: flush the resolver cache. */
export function __clearProtocolResolverCache(): void {
  CACHE.clear()
}
