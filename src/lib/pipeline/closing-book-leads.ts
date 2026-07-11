import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptLeadsPII } from '@/lib/encryption'
import type { Lead } from '@/types/database'

/**
 * Closing-book ⇄ CRM lead bridge.
 *
 * A row on the In-Closing board (`closing_book`) is only clickable — Call / SMS /
 * Email + the full lead detail page — when it points at a real CRM lead. The
 * board's rows come from the practice's hand-kept "Case Follow ups" sheet, and
 * many of those patients were never imported as leads (pre-CRM or referral
 * deals; the sheet carries no phone/email). This module owns the matching so
 * every closing row can reach a patient record:
 *
 *   - exactly one lead with that name  → link it
 *   - no lead with that name           → create a minimal record and link it
 *   - several leads with that name      → ambiguous; leave for a human to pick
 *
 * A created lead is deliberately bare (name + case value): no phone/email means
 * the action bar shows honest disabled buttons until staff add a number, and a
 * null `stage_id` keeps these off the curated sales pipeline board — they live
 * on the closing board, not in the New-Lead intake funnel.
 */

/** Everything needed to match or mint a lead for one closing row. */
export type ClosingLeadSeed = {
  firstName: string
  lastName: string
  service?: string | null
  caseValue?: number | null
}

export type ClosingLeadResolution =
  /** Matched or minted a single lead — its id is on the row now. */
  | { status: 'linked'; leadId: string; created: boolean }
  /** No lead exists for this name and creation was not requested (dry-run). */
  | { status: 'none' }
  /** Several leads share the name; a human must choose which. */
  | { status: 'ambiguous'; candidateCount: number }

/** One candidate for the "which patient is this?" picker. */
export type ClosingLeadCandidate = {
  id: string
  firstName: string
  lastName: string | null
  /** Last 4 of the phone (decrypted, masked) — just enough to tell people apart. */
  phoneLast4: string | null
  city: string | null
  state: string | null
  status: string | null
  lastContactedAt: string | null
  createdAt: string | null
}

const CANDIDATE_COLUMNS =
  'id, first_name, last_name, phone_formatted, phone, city, state, status, last_contacted_at, created_at'

/** Case-insensitive exact match on both name parts — the seed's matching rule. */
async function findLeadsByName(
  supabase: SupabaseClient,
  orgId: string,
  firstName: string,
  lastName: string,
  columns: string
): Promise<Record<string, unknown>[]> {
  const first = firstName.trim()
  const last = lastName.trim()
  let query = supabase
    .from('leads')
    .select(columns)
    .eq('organization_id', orgId)
    // `ilike` with no wildcards is a case-insensitive exact compare.
    .ilike('first_name', first)
  // A single-name sheet row ("Gerri") has no last name; match the same shape.
  query = last ? query.ilike('last_name', last) : query.or('last_name.is.null,last_name.eq.')
  const { data } = await query.limit(25)
  return (data as Record<string, unknown>[] | null) ?? []
}

/**
 * Create a bare CRM lead for a sheet-only closing patient and return its id.
 *
 * No PII (no email/phone) → no encryption or search-hash work is needed. Status
 * `treatment_presented` reflects a deal actively being closed; `stage_id` is
 * left null so the record stays off the sales pipeline board.
 */
export async function createClosingLead(
  supabase: SupabaseClient,
  orgId: string,
  seed: ClosingLeadSeed
): Promise<string> {
  const firstName = seed.firstName.trim() || 'Unnamed'
  const lastName = seed.lastName.trim() || null
  const noteBits = ['Imported from the closing book']
  if (seed.service?.trim()) noteBits.push(seed.service.trim())

  const { data, error } = await supabase
    .from('leads')
    .insert({
      organization_id: orgId,
      first_name: firstName,
      last_name: lastName,
      status: 'treatment_presented',
      source_type: 'closing_book',
      treatment_value: seed.caseValue ?? null,
      notes: noteBits.join(' — '),
      tags: ['closing-book'],
    })
    .select('id')
    .single()

  if (error || !data) {
    throw new Error(`Failed to create closing lead for ${firstName} ${lastName ?? ''}: ${error?.message}`)
  }
  return data.id as string
}

/**
 * Resolve a closing row to a CRM lead: link an existing one, mint one when none
 * exists, or report ambiguity when several share the name.
 *
 * `create` defaults to true (the sync/link callers want a reachable record). Pass
 * `create: false` for a read-only preview — a no-match then returns `none`
 * instead of writing a lead (so dry-runs have no side effects).
 */
export async function resolveClosingLead(
  supabase: SupabaseClient,
  orgId: string,
  seed: ClosingLeadSeed,
  opts: { create?: boolean } = {}
): Promise<ClosingLeadResolution> {
  const matches = await findLeadsByName(supabase, orgId, seed.firstName, seed.lastName, 'id')

  if (matches.length === 1) {
    return { status: 'linked', leadId: matches[0].id as string, created: false }
  }
  if (matches.length > 1) {
    return { status: 'ambiguous', candidateCount: matches.length }
  }
  if (opts.create === false) return { status: 'none' }
  const leadId = await createClosingLead(supabase, orgId, seed)
  return { status: 'linked', leadId, created: true }
}

/** List the candidate patients for a closing row's name, for the UI picker. */
export async function listClosingCandidates(
  supabase: SupabaseClient,
  orgId: string,
  seed: Pick<ClosingLeadSeed, 'firstName' | 'lastName'>
): Promise<ClosingLeadCandidate[]> {
  const rows = await findLeadsByName(supabase, orgId, seed.firstName, seed.lastName, CANDIDATE_COLUMNS)
  // Decrypt so we can surface a phone hint; only the last 4 leaves this function.
  const decrypted = decryptLeadsPII(rows as unknown as Lead[])
  return decrypted
    .map((l) => {
      const phone = (l.phone_formatted || l.phone || '').replace(/\D/g, '')
      return {
        id: l.id,
        firstName: l.first_name,
        lastName: l.last_name ?? null,
        phoneLast4: phone ? phone.slice(-4) : null,
        city: l.city ?? null,
        state: l.state ?? null,
        status: l.status ?? null,
        lastContactedAt: l.last_contacted_at ?? null,
        createdAt: l.created_at ?? null,
      }
    })
    .sort((a, b) => {
      // Most-recently-active first — the likeliest match to pick.
      const at = a.lastContactedAt ?? a.createdAt ?? ''
      const bt = b.lastContactedAt ?? b.createdAt ?? ''
      return bt.localeCompare(at)
    })
}
