import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { resolveDiscoveryScript } from '@/lib/ai/discovery-script'

/**
 * Return the discovery-call script for the caller's active practice: the
 * per-practice override from `booking_settings.discovery_script` when present,
 * otherwise the built-in default. Selecting `*` keeps this forward-compatible —
 * if the override column doesn't exist yet, `discovery_script` is simply
 * undefined and we fall back to the default.
 */
export async function GET() {
  const supabase = await createClient()

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data } = await supabase
    .from('booking_settings')
    .select('*')
    .eq('organization_id', orgId)
    .maybeSingle()

  const override = (data as Record<string, unknown> | null)?.discovery_script
  const script = resolveDiscoveryScript(typeof override === 'string' ? override : null)

  return NextResponse.json({ script })
}
