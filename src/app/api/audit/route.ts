import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { fetchAuditTimeline, type AuditFilter } from '@/lib/audit/query'
import type { ActorType } from '@/lib/audit/types'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const active = await resolveActiveOrg(supabase)
  if (!active.orgId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const sp = request.nextUrl.searchParams
  const filter: AuditFilter = {
    resourceType: sp.get('resourceType') ?? undefined,
    resourceId: sp.get('resourceId') ?? undefined,
    actorType: (sp.get('actorType') as ActorType) ?? undefined,
    action: sp.get('action') ?? undefined,
    since: sp.get('since') ?? undefined,
    limit: sp.get('limit') ? Number(sp.get('limit')) : undefined,
  }
  const rows = await fetchAuditTimeline(supabase, active.orgId, filter)
  return NextResponse.json({ rows })
}
