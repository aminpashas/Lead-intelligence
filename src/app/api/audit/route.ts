import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/auth/active-org'
import { fetchAuditTimeline, type AuditFilter } from '@/lib/audit/query'
import type { ActorType } from '@/lib/audit/types'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  // Same gate as the /audit page (broadcast_audit:read) — 401/403 otherwise.
  const guard = await requirePermission(supabase, 'broadcast_audit:read')
  if ('error' in guard) return guard.error
  const sp = request.nextUrl.searchParams
  const filter: AuditFilter = {
    resourceType: sp.get('resourceType') ?? undefined,
    resourceId: sp.get('resourceId') ?? undefined,
    actorType: (sp.get('actorType') as ActorType) ?? undefined,
    action: sp.get('action') ?? undefined,
    since: sp.get('since') ?? undefined,
    limit: sp.get('limit') ? Number(sp.get('limit')) : undefined,
    // Default-on; `?materialOnly=false` opens the raw firehose.
    materialOnly: sp.get('materialOnly') !== 'false',
  }
  const rows = await fetchAuditTimeline(supabase, guard.orgId, filter)
  return NextResponse.json({ rows })
}
