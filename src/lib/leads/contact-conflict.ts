/**
 * Duplicate-contact detection for staff-entered phone numbers.
 *
 * Phone is deliberately NOT uniquely indexed (see
 * migrations/20260603_unique_email_hash_index.sql) because people legitimately
 * share a line — spouses, a household phone, a parent submitting for a child.
 * So the database will happily accept a duplicate.
 *
 * The cost of that duplicate is silent and shows up later: the next inbound SMS
 * or call carrying the number hits `findExistingLeads` (lib/leads/dedupe.ts),
 * which resolves by phone_hash and takes whichever row PostgREST returns first.
 * From then on, messages can land on the wrong lead's thread with nothing in the
 * UI to explain it.
 *
 * We therefore don't block the write — we surface the collision at entry time
 * and let the person typing decide, since only they know whether this is a
 * shared household line or a mistake.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { searchHash } from '@/lib/encryption'

export type PhoneConflict = {
  id: string
  first_name: string | null
  last_name: string | null
  status: string | null
}

/**
 * Leads in the same org that already carry this E.164 number, excluding the
 * lead being edited. Matches on phone_hash — the same deterministic hash the
 * inbound dedup path uses, so this finds exactly the rows that would actually
 * contend for a future inbound message.
 */
export async function findPhoneConflicts(
  supabase: SupabaseClient,
  orgId: string,
  phoneE164: string,
  excludeLeadId: string,
): Promise<PhoneConflict[]> {
  const hash = searchHash(phoneE164)
  if (!hash) return []

  const { data, error } = await supabase
    .from('leads')
    .select('id, first_name, last_name, status')
    .eq('organization_id', orgId)
    .eq('phone_hash', hash)
    .neq('id', excludeLeadId)
    .limit(5)

  // Best-effort: a failed conflict lookup must never block a legitimate edit.
  if (error || !data) return []
  return data.filter(isRoutingRival)
}

/**
 * ── DECISION POINT ──────────────────────────────────────────────────────────
 * Which duplicates are worth interrupting someone over?
 *
 * Current rule: warn only about leads that could actually steal a future
 * inbound message. A lead that is closed out — lost, disqualified, completed —
 * still matches on phone_hash, so it is arguably still a routing rival; but
 * warning about every long-dead record trains staff to click through the
 * warning, which defeats it.
 *
 * This is a workflow call, not a technical one — tune the list to how the
 * practice actually works.
 */
function isRoutingRival(lead: PhoneConflict): boolean {
  const DORMANT = new Set(['lost', 'disqualified', 'completed'])
  return !DORMANT.has(lead.status ?? '')
}

/** "Elaine Ballard" / "an unnamed lead" — for the confirmation prompt. */
export function describeConflict(lead: PhoneConflict): string {
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim()
  return name || 'an unnamed lead'
}
