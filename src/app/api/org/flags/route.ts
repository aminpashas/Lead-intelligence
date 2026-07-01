import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { getOrgFlags } from '@/lib/org/flags'

// GET /api/org/flags — the active org's feature flags, for client-side gating
// and banners (e.g. the A2P US-SMS pause). Honors an agency admin's entered org.
export async function GET() {
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const flags = await getOrgFlags(supabase, orgId)
  return NextResponse.json({ flags })
}
