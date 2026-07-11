/**
 * PATCH /api/closing/[id] — staff edits to a row on the In-Closing board.
 *
 * The board renders the `closing_book` table (the curated deals seeded from the
 * practice's "Case Follow ups" sheet). These are the two human-judgment fields
 * the board lets staff change inline: a closing-temperature override and the
 * free-text next step. Both optional; sending one leaves the other untouched. A
 * null temperature clears the override so the board falls back to the derived
 * value.
 */
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'

const bodySchema = z
  .object({
    temperature: z.enum(['hot', 'warm', 'deliberating', 'cold', 'stalled']).nullable().optional(),
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

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (parsed.data.temperature !== undefined) update.temperature = parsed.data.temperature
  if (parsed.data.nextStep !== undefined) update.next_step = parsed.data.nextStep

  // RLS + explicit org scope = defense in depth.
  const { data: updated, error } = await supabase
    .from('closing_book')
    .update(update)
    .eq('id', id)
    .eq('organization_id', orgId)
    .select('id, temperature, next_step, updated_at')
    .single()

  if (error || !updated) {
    return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  }

  return NextResponse.json({ row: updated })
}
