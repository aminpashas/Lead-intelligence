import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decryptLeadsPII, searchHash } from '@/lib/encryption'
import { auditPHIRead } from '@/lib/hipaa-audit'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { formatToE164 } from '@/lib/leads/phone'

// Minimum characters before we run a lookup — keeps the PHI-read audit trail from
// filling with 1-char noise and avoids matching nearly every lead.
const MIN_CHARS = 2
const DEFAULT_LIMIT = 8
const MAX_LIMIT = 15

/**
 * GET /api/leads/search?q=<term>&limit=<n>
 *
 * Lightweight typeahead lookup for the global search bar. Unlike GET /api/leads,
 * this selects only the handful of fields the dropdown renders (no pipeline/source
 * joins) and matches email/phone the way they're actually stored — encrypted, with
 * deterministic hashes for lookup:
 *   - names   → ilike substring on first_name/last_name
 *   - email   → exact match on email_hash (full address only)
 *   - phone   → exact match on phone_hash, hashing both the raw term and its E.164
 *               form, since phone_hash is derived from phone_formatted (+1XXXXXXXXXX)
 *
 * PHI access is audited once per request (coarse grain) rather than per row.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { searchParams } = new URL(request.url)

  const { data: profile } = await getOwnProfile(supabase, 'id, organization_id')
  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Scope to the effective org (agency admins operate on the entered client).
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const q = (searchParams.get('q') || '').trim()
  if (q.length < MIN_CHARS) {
    return NextResponse.json({ leads: [] })
  }
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(searchParams.get('limit') || String(DEFAULT_LIMIT)) || DEFAULT_LIMIT),
  )

  // Strip characters that have meaning in PostgREST's or()/and() grammar so a
  // value like "O'Brien, Amin" can't break out of the filter expression.
  const clean = (s: string) => s.replace(/[(),*%\\"]/g, '')
  const cleanedQ = clean(q)

  // Hash lookups for the encrypted columns. phone_hash is built from the E.164
  // form, so hash both the raw term and its normalized form to catch either input.
  const rawHash = searchHash(q)
  const e164 = formatToE164(q)
  const e164Hash = e164 ? searchHash(e164) : null

  const conds = [
    `first_name.ilike.%${cleanedQ}%`,
    `last_name.ilike.%${cleanedQ}%`,
  ]
  if (rawHash) {
    conds.push(`email_hash.eq.${rawHash}`)
    conds.push(`phone_hash.eq.${rawHash}`)
  }
  if (e164Hash) {
    conds.push(`phone_hash.eq.${e164Hash}`)
  }

  // A full name ("Amin Samadian") spans two columns, so require each token to
  // appear across first/last name rather than matching the whole string to one.
  const tokens = q.split(/\s+/).map(clean).filter(Boolean)
  if (tokens.length > 1) {
    const perToken = tokens
      .map((t) => `or(first_name.ilike.%${t}%,last_name.ilike.%${t}%)`)
      .join(',')
    conds.push(`and(${perToken})`)
  }

  const { data, error } = await supabase
    .from('leads')
    .select('id, first_name, last_name, email, phone, phone_formatted, ai_qualification')
    .eq('organization_id', orgId)
    .or(conds.join(','))
    .order('last_contacted_at', { ascending: false, nullsFirst: false })
    .limit(limit)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (data && data.length > 0) {
    auditPHIRead(
      { supabase, organizationId: orgId, actorId: profile.id },
      'lead',
      `search:${data.length}`,
      `Typeahead search surfaced ${data.length} lead record(s)`,
    )
  }

  return NextResponse.json({ leads: decryptLeadsPII(data || []) })
}
