import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { applySmartListCriteria } from '@/lib/campaigns/smart-list-resolver'
import { getTemplateAudienceCriteria } from '@/lib/campaigns/reactivation-audience'
import { REACTIVATION_TEMPLATES } from '@/lib/campaigns/reactivation-templates'

// GET /api/reactivation/templates/counts
// Matching-lead count per template, for the audience badges on template cards.
export async function GET() {
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const counts: Record<string, number> = {}

  await Promise.all(
    REACTIVATION_TEMPLATES.map(async (template) => {
      const criteria = getTemplateAudienceCriteria(template.id)
      if (!criteria) {
        counts[template.id] = 0
        return
      }
      let query = supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId)
      query = applySmartListCriteria(query, criteria)
      const { count } = await query
      counts[template.id] = count || 0
    })
  )

  return NextResponse.json({ counts })
}
