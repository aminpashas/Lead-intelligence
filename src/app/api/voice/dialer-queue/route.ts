/**
 * Power-dialer "load next batch" endpoint.
 *
 * GET /api/voice/dialer-queue?exclude=<comma ids>&offset=<n>
 *
 * Returns the next batch of callable leads for the browser power dialer, using the
 * SAME filter + ordering as the Call Center's server-fetched initial batch (see
 * lib/voice/dialer-queue) so the two never drift. Leads the staffer has already
 * loaded or handled this session are passed as `exclude`; leads contacted in the
 * last 24h are dropped automatically. Gated on call_center:read — the Recent-calls /
 * dialer surface embeds decrypted lead PII, so nav hiding is a courtesy and this is
 * the boundary.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { hasPermission } from '@/lib/auth/permissions'
import { fetchDialerQueue, DIALER_BATCH_SIZE } from '@/lib/voice/dialer-queue'

export async function GET(request: NextRequest) {
  const supabase = await createClient()

  // Effective org honors an agency_admin's entered client account.
  const { orgId, role } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(role || 'member', 'call_center:read')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const params = request.nextUrl.searchParams
  const excludeIds = (params.get('exclude') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const offset = Math.max(0, Number(params.get('offset')) || 0)

  const leads = await fetchDialerQueue(supabase, orgId, {
    offset,
    excludeIds,
    excludeRecentlyContacted: true,
  })

  return NextResponse.json({ leads, nextOffset: offset + leads.length, batchSize: DIALER_BATCH_SIZE })
}
