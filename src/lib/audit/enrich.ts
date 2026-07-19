import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptLeadsPII } from '@/lib/encryption'

/**
 * Resolves the ids stored on audit events into names a human can read.
 *
 * The audit log deliberately stores ids, not names — names change, and a WORM
 * log must not carry a stale copy of one. Resolution happens at read time, in
 * two batched lookups regardless of how many rows are on screen.
 */

/**
 * The two logs disagree on naming: audit_events stores the TABLE name
 * (`leads`, set by the trigger from TG_TABLE_NAME) while hipaa_audit_log
 * stores a singular entity name (`lead`). 127,609 of the PHI-access rows use
 * the singular form, so without this alias the whole HIPAA half of the
 * timeline renders with no record name at all.
 */
const RESOURCE_ALIASES: Record<string, string> = {
  lead: 'leads',
  appointment: 'appointments',
  campaign: 'campaigns',
  pipeline_stage: 'pipeline_stages',
}

function canonicalType(resourceType: string): string {
  return RESOURCE_ALIASES[resourceType] ?? resourceType
}

/** Tables whose rows we can put a human label on, and how to build it. */
const RESOURCE_LABELS: Record<
  string,
  { table: string; select: string; href: (id: string) => string; label: (row: Record<string, unknown>) => string }
> = {
  leads: {
    table: 'leads',
    select: 'id,first_name,last_name',
    href: (id) => `/leads/${id}`,
    label: (r) => {
      const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
      return name || 'Unnamed lead'
    },
  },
  appointments: {
    table: 'appointments',
    select: 'id,title',
    href: (id) => `/appointments?id=${id}`,
    label: (r) => (r.title as string) || 'Appointment',
  },
  campaigns: {
    table: 'campaigns',
    select: 'id,name',
    href: (id) => `/campaigns/${id}`,
    label: (r) => (r.name as string) || 'Campaign',
  },
  pipeline_stages: {
    table: 'pipeline_stages',
    select: 'id,name',
    href: () => '/pipeline',
    label: (r) => (r.name as string) || 'Stage',
  },
}

export type ResourceRef = { label: string; href: string | null }

/** actor_id → display name, from user_profiles. */
export async function resolveActorNames(
  supabase: SupabaseClient,
  actorIds: string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(actorIds.filter(Boolean))]
  if (unique.length === 0) return new Map()

  const { data } = await supabase
    .from('user_profiles')
    .select('id,full_name,email')
    .in('id', unique)

  const out = new Map<string, string>()
  for (const row of data ?? []) {
    out.set(row.id, row.full_name || row.email || 'Unknown user')
  }
  return out
}

/**
 * `${resourceType}:${resourceId}` → { label, href }.
 *
 * Lead names live encrypted at rest (`enc::…`), so they must go through
 * decryptLeadsPII before display — a raw select renders ciphertext.
 */
export async function resolveResourceRefs(
  supabase: SupabaseClient,
  organizationId: string,
  refs: { resourceType: string | null; resourceId: string | null }[]
): Promise<Map<string, ResourceRef>> {
  const byType = new Map<string, Set<string>>()
  for (const { resourceType, resourceId } of refs) {
    if (!resourceType || !resourceId) continue
    const canonical = canonicalType(resourceType)
    if (!(canonical in RESOURCE_LABELS)) continue
    if (!byType.has(canonical)) byType.set(canonical, new Set())
    byType.get(canonical)!.add(resourceId)
  }

  const out = new Map<string, ResourceRef>()

  await Promise.all(
    [...byType.entries()].map(async ([resourceType, ids]) => {
      const spec = RESOURCE_LABELS[resourceType]
      const { data } = await supabase
        .from(spec.table)
        .select(spec.select)
        .eq('organization_id', organizationId)
        .in('id', [...ids])

      // The table name is dynamic, so supabase-js cannot infer a row type here
      // (it widens to GenericStringError[]); narrow it explicitly.
      const raw = (data ?? []) as unknown as Record<string, unknown>[]
      const rows = resourceType === 'leads' ? decryptLeadsPII(raw) : raw
      for (const row of rows) {
        const id = row.id as string
        out.set(`${resourceType}:${id}`, { label: spec.label(row), href: spec.href(id) })
      }
    })
  )

  return out
}

/**
 * Stable key for the resource-ref map. Canonicalizes the type so a lookup
 * with either naming convention (`lead` or `leads`) hits the same entry.
 */
export function refKey(resourceType: string | null, resourceId: string | null): string | null {
  if (!resourceType || !resourceId) return null
  return `${canonicalType(resourceType)}:${resourceId}`
}
