import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { smartListCriteriaSchema } from '@/lib/validators/smart-list'
import { applySmartListCriteria } from '@/lib/campaigns/smart-list-resolver'
import { decryptLeadsPII } from '@/lib/encryption'

/**
 * The FULL lead cohort behind a Pipeline recommendation — paginated, so the
 * card's drill-down sheet can list every lead the recommendation targets (not
 * just the ≤12-row inline peek that `../preview` returns) and let the user open
 * each one to work it.
 *
 * Resolution mirrors `../preview` exactly (`applySmartListCriteria` over the
 * rec's own `criteria`), so the sheet's list, its running total, and the count
 * advertised on the card all describe the same segment. Engine-generated
 * recommendation criteria only use scalar/stage predicates (stage, consent,
 * recency, qualification, intent) — never tags/keywords — so
 * `applySmartListCriteria` alone fully resolves them.
 *
 * Rows are ranked by `ai_score` (most valuable first, matching the "By signal"
 * columns) and PII is decrypted server-side before returning.
 */

const MAX_PAGE = 100
const DEFAULT_PAGE = 50

const cohortSchema = z.object({
  criteria: smartListCriteriaSchema,
  limit: z.number().int().positive().max(MAX_PAGE).optional(),
  offset: z.number().int().min(0).optional(),
})

export type RecommendationCohortLead = {
  id: string
  name: string
  city: string | null
  aiQualification: string | null
  aiScore: number | null
  conversationIntent: string | null
  lastContactedAt: string | null
  createdAt: string | null
}

export type RecommendationCohortPage = {
  leads: RecommendationCohortLead[]
  total: number
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = cohortSchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const limit = parsed.data.limit ?? DEFAULT_PAGE
  const offset = parsed.data.offset ?? 0

  let query = supabase
    .from('leads')
    .select(
      'id, first_name, last_name, city, ai_qualification, ai_score, conversation_intent, last_contacted_at, created_at',
      { count: 'exact' }
    )
    .eq('organization_id', orgId)
  query = applySmartListCriteria(query, parsed.data.criteria)

  const { data, count, error } = await query
    .order('ai_score', { ascending: false, nullsFirst: false })
    .range(offset, offset + limit - 1)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const leads: RecommendationCohortLead[] = decryptLeadsPII(data || []).map((l) => {
    const first = (l.first_name as string | null)?.trim() || ''
    const last = (l.last_name as string | null)?.trim() || ''
    const name = `${first} ${last}`.trim() || 'Unnamed lead'
    return {
      id: l.id as string,
      name,
      city: (l.city as string | null) || null,
      aiQualification: (l.ai_qualification as string | null) || null,
      aiScore: (l.ai_score as number | null) ?? null,
      conversationIntent: (l.conversation_intent as string | null) || null,
      lastContactedAt: (l.last_contacted_at as string | null) || null,
      createdAt: (l.created_at as string | null) || null,
    }
  })

  const page: RecommendationCohortPage = { leads, total: count ?? 0 }
  return NextResponse.json(page)
}
