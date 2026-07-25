/**
 * EHR adapter registry — the one file that grows when we add an EMR.
 *
 * Adding EMR #2 is: a new directory under lib/ehr/, one line in ADAPTERS, one
 * value in the connector_configs.connector_type check constraint, and a webhook
 * route if the vendor pushes. Nothing else changes.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { EhrSource } from '@/types/database'
import type { EhrAdapter } from './port'
import { carestackAdapter } from './carestack/adapter'

/**
 * Keyed by connector_configs.connector_type, which for EHR connectors is also
 * the `ehr_source` written onto every row. Keeping those identical is what lets
 * the rollup resolve a row's adapter straight from its `ehr_source` column.
 */
const ADAPTERS: Record<string, EhrAdapter> = {
  carestack: carestackAdapter,
}

/** Every connector_type that is an EHR — used to scope the cron's org query. */
export const EHR_CONNECTOR_TYPES: string[] = Object.keys(ADAPTERS)

/**
 * Look up an adapter by source. Returns undefined for an unknown/legacy source
 * (e.g. 'manual' rows, or data synced by an EMR whose adapter was removed).
 * Callers must treat undefined as "skip", never as an error.
 */
export function getAdapter(source: unknown): EhrAdapter | undefined {
  if (typeof source !== 'string') return undefined
  return ADAPTERS[source]
}

export function isEhrSource(source: unknown): source is EhrSource {
  return getAdapter(source) !== undefined
}

export type ResolvedAdapter = { adapter: EhrAdapter; config: unknown }

/**
 * Adapters that are configured AND enabled for this org, with their configs
 * resolved. An adapter whose getConfig returns null (unconfigured, disabled, or
 * missing credentials) is omitted rather than surfaced as a failure.
 *
 * Never throws: a single adapter with a broken config must not stop the others.
 */
export async function getEnabledAdapters(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<ResolvedAdapter[]> {
  const resolved: ResolvedAdapter[] = []
  for (const adapter of Object.values(ADAPTERS)) {
    try {
      const config = await adapter.getConfig(supabase, organizationId)
      if (config) resolved.push({ adapter, config })
    } catch {
      // A malformed config for one vendor is a skip, not an outage.
    }
  }
  return resolved
}
