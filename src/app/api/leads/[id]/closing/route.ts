/**
 * PATCH /api/leads/[id]/closing — staff edits to a deal on the In-Closing board.
 *
 * The board is otherwise a read-only lens on real pipeline data (stage, case
 * value, close probability). These are the two human-judgment fields the old
 * "Case Follow ups" spreadsheet carried that the CRM did not: a closing
 * temperature override and a free-text next step. Both are optional; sending one
 * leaves the other untouched. A null temperature clears the override (the board
 * falls back to the derived value).
 */
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'

const bodySchema = z
  .object({
    temperature: z.enum(['hot', 'warm', 'cold', 'stalled']).nullable().optional(),
    nextStep: z.string().max(2000).nullable().optional(),
  })
  .refine((b) => b.temperature !== undefined || b.nextStep !== undefined, {
    message: 'Provide temperature and/or nextStep',
  })

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  // Effective org honors an agency_admin's entered client account.
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await getOwnProfile(supabase, 'id, organization_id')
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = bodySchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  // Confirm the lead exists in this org (RLS + explicit scope = defense in depth).
  const { data: lead } = await supabase
    .from('leads')
    .select('id, organization_id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })

  const update: Record<string, unknown> = { closing_updated_at: new Date().toISOString() }
  if (parsed.data.temperature !== undefined) update.closing_temperature = parsed.data.temperature
  if (parsed.data.nextStep !== undefined) update.closing_next_step = parsed.data.nextStep

  const { data: updated, error } = await supabase
    .from('leads')
    .update(update)
    .eq('id', id)
    .eq('organization_id', orgId)
    .select('id, closing_temperature, closing_next_step, closing_updated_at')
    .single()

  if (error) {
    return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  }

  return NextResponse.json({ lead: updated })
}
