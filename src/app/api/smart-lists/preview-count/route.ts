import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { z } from 'zod'
import { resolveSmartListLeads } from '@/lib/campaigns/smart-list-resolver'
import { smartListCriteriaSchema } from '@/lib/validators/smart-list'

const bodySchema = z.object({ criteria: smartListCriteriaSchema })

// POST /api/smart-lists/preview-count — count leads matching a criteria set
// WITHOUT persisting anything. Powers the live "N leads match" preview in the
// Smart List builder and the Leads-page advanced search. Read-only: it resolves
// the same criteria every consumer uses (countOnly) and returns just the count,
// replacing the old create-a-throwaway-list-then-delete-it hack.
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { count } = await resolveSmartListLeads(supabase, orgId, parsed.data.criteria, {
    countOnly: true,
  })
  return NextResponse.json({ count })
}
