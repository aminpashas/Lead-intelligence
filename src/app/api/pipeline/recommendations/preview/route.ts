import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { smartListCriteriaSchema } from '@/lib/validators/smart-list'
import { applySmartListCriteria } from '@/lib/campaigns/smart-list-resolver'
import { decryptLeadsPII } from '@/lib/encryption'

/**
 * Preview a Pipeline recommendation's segment — WHICH leads it targets.
 *
 * The recommendations band shows a count ("142 cooling leads"); this endpoint
 * backs the card's expandable list by returning a small, ranked sample of the
 * actual leads in that segment so the user can see who they are and click
 * through to any of them.
 *
 * It resolves the recommendation's own `criteria` (the exact segment "Apply"
 * would target), so the preview can never disagree with the advertised count.
 * Engine-generated recommendation criteria only use scalar/stage predicates
 * (stage, consent, recency, qualification, intent) — never tags/keywords — so
 * `applySmartListCriteria` alone is sufficient here.
 *
 * PII is encrypted at rest, so names are decrypted server-side before returning.
 */

const PREVIEW_LIMIT = 12

const previewSchema = z.object({
  criteria: smartListCriteriaSchema,
})

export type RecommendationPreviewLead = {
  id: string
  name: string
  city: string | null
  aiQualification: string | null
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = previewSchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  let query = supabase
    .from('leads')
    .select('id, first_name, last_name, city, ai_qualification, ai_score')
    .eq('organization_id', orgId)
  query = applySmartListCriteria(query, parsed.data.criteria)

  // Rank by ai_score so the preview surfaces the most valuable leads first —
  // matches the "By signal" columns' ordering.
  const { data, error } = await query
    .order('ai_score', { ascending: false, nullsFirst: false })
    .limit(PREVIEW_LIMIT)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const leads: RecommendationPreviewLead[] = decryptLeadsPII(data || []).map((l) => {
    const first = (l.first_name as string | null)?.trim() || ''
    const last = (l.last_name as string | null)?.trim() || ''
    const name = `${first} ${last}`.trim() || 'Unnamed lead'
    return {
      id: l.id as string,
      name,
      city: (l.city as string | null) || null,
      aiQualification: (l.ai_qualification as string | null) || null,
    }
  })

  return NextResponse.json({ leads })
}
