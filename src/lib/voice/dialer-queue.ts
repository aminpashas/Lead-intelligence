/**
 * Power-dialer queue — the single source of truth for "which leads are callable
 * right now, in what order".
 *
 * The queue is pre-filtered to leads that would actually pass the compliance gate
 * (has phone, consented, not DNC / opted-out) and to still-open statuses. Ordering
 * is highest AI score first so the staffer isn't handed dead ends — but scores are
 * frequently absent (an org may have no leads scored yet), which leaves the whole
 * candidate set tied at 0. When that happens the score key is meaningless and a bare
 * LIMIT would return an arbitrary, unstable slice, so we fall back to freshest-first
 * (never-contacted → most-recently-contacted → newest lead) with an `id` tiebreak for
 * a deterministic queue. Each dial still re-runs the full gate server-side in
 * /api/voice/prepare.
 *
 * Both the Call Center's Power Dialer tab (server-fetched initial batch) and the
 * /api/voice/dialer-queue "load next batch" route call through here, so the two can
 * never drift apart.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptLeadPII } from '@/lib/encryption'

/** How many callable leads a single batch holds. */
export const DIALER_BATCH_SIZE = 100

/** Skip leads contacted within this window when claiming a fresh batch. */
const CONTACT_COOLDOWN_MS = 24 * 60 * 60 * 1000

// Columns the dialer card needs. `ai_summary` / `conversation_summary` give the
// staffer inline context; phone fields are decrypted server-side and reduced to a
// last-4 before they reach the client.
const DIALER_SELECT =
  'id, first_name, last_name, phone, phone_formatted, ai_score, ai_qualification, status, last_contacted_at, city, state, ai_summary, conversation_summary'

/** The slim, display-safe lead the dialer walks (never the full number). */
export type DialerLead = {
  id: string
  first_name: string
  last_name: string | null
  ai_score: number | null
  ai_qualification: string
  status: string
  last_contacted_at: string | null
  city: string | null
  state: string | null
  phone_last4: string
  /** Latest AI/conversation context so the card isn't a bare name (no PHI). */
  note: string | null
}

/** Decrypt PII server-side and reduce a raw leads row to the display-safe shape. */
export function mapDialerLead(r: Record<string, unknown>): DialerLead {
  const dec = decryptLeadPII(r)
  const phone = ((dec.phone_formatted as string) || (dec.phone as string) || '').replace(/[^0-9]/g, '')
  const note = ((r.conversation_summary as string) || (r.ai_summary as string) || '').trim()
  return {
    id: r.id as string,
    first_name: (dec.first_name as string) || 'Lead',
    last_name: (dec.last_name as string) || null,
    ai_score: (r.ai_score as number) ?? null,
    ai_qualification: (r.ai_qualification as string) || 'unscored',
    status: (r.status as string) || 'new',
    last_contacted_at: (r.last_contacted_at as string) || null,
    city: (dec.city as string) || null,
    state: (r.state as string) || null,
    phone_last4: phone.slice(-4),
    note: note || null,
  }
}

export type DialerQueueOptions = {
  /** Row offset for pagination (default 0). */
  offset?: number
  /** Batch size (default DIALER_BATCH_SIZE). */
  limit?: number
  /** Lead ids to exclude — the ones the staffer has already loaded/handled. */
  excludeIds?: string[]
  /**
   * Drop leads contacted in the last 24h. Off for the initial page load (which
   * preserves the legacy freshest-first behavior), on for "load next batch" so a
   * just-worked lead can't resurface mid-session.
   */
  excludeRecentlyContacted?: boolean
}

/**
 * Fetch a batch of callable leads for the power dialer, decrypted and reduced to
 * the display-safe DialerLead shape. Applies the shared compliance-adjacent filter
 * and the deterministic score-then-freshness ordering.
 */
export async function fetchDialerQueue(
  supabase: SupabaseClient,
  orgId: string,
  opts: DialerQueueOptions = {},
): Promise<DialerLead[]> {
  const limit = opts.limit ?? DIALER_BATCH_SIZE
  const offset = opts.offset ?? 0

  let query = supabase
    .from('leads')
    .select(DIALER_SELECT)
    .eq('organization_id', orgId)
    .eq('do_not_call', false)
    .eq('voice_opt_out', false)
    .eq('voice_consent', true)
    .not('phone', 'is', null)
    .not('status', 'in', '(lost,disqualified,completed)')

  // Skip anyone already worked within the cooldown (never-contacted always passes).
  if (opts.excludeRecentlyContacted) {
    const cutoff = new Date(Date.now() - CONTACT_COOLDOWN_MS).toISOString()
    query = query.or(`last_contacted_at.is.null,last_contacted_at.lt.${cutoff}`)
  }

  // Drop leads the staffer has already seen or handled this session.
  if (opts.excludeIds && opts.excludeIds.length > 0) {
    // ids are UUIDs, but guard the IN-list against anything that could break out.
    const safe = opts.excludeIds.filter((id) => /^[0-9a-fA-F-]{36}$/.test(id))
    if (safe.length > 0) query = query.not('id', 'in', `(${safe.join(',')})`)
  }

  query = query
    // Score wins when it exists; otherwise everything ties at 0, so freshest-first
    // (never-contacted → most-recent contact → newest lead) drives the queue, with
    // `id` as a deterministic tiebreak so the same queue renders on every load.
    .order('ai_score', { ascending: false, nullsFirst: false })
    .order('last_contacted_at', { ascending: false, nullsFirst: true })
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1)

  const { data: rows } = await query
  return (rows || []).map((r) => mapDialerLead(r as Record<string, unknown>))
}
