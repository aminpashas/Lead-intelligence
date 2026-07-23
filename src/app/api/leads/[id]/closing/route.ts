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
import { decryptField } from '@/lib/encryption'
import { setLeadHold, clearLeadHold, decideFollowUpHold } from '@/lib/automation/hold-tasks'
import { leadDisplayName } from '@/lib/leads/display-name'
import { logger } from '@/lib/logger'

const bodySchema = z
  .object({
    temperature: z.enum(['hot', 'warm', 'cold', 'stalled', 'deliberating']).nullable().optional(),
    nextStep: z.string().max(2000).nullable().optional(),
    // When a deal is marked 'deliberating', the date the closer agreed to circle
    // back. Mutes the deal from the live queue until then (see closingQueueState)
    // AND pauses all outbound automation until then via a lead hold (below), so no
    // automated text/call/email reaches the patient before the follow-up date.
    followUpAt: z.string().datetime().nullable().optional(),
    // Why they paused — reuses the conversation-analysis objection vocabulary.
    reason: z
      .enum(['cost', 'financing', 'fear_anxiety', 'timing', 'trust', 'medical', 'logistics', 'spouse_approval', 'none', 'other'])
      .nullable()
      .optional(),
  })
  .refine(
    (b) =>
      b.temperature !== undefined ||
      b.nextStep !== undefined ||
      b.followUpAt !== undefined ||
      b.reason !== undefined,
    { message: 'Provide at least one field to update' }
  )

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
  // We also read the pre-update hold/follow-up state so the auto-hold below can
  // tell a hold IT placed for this follow-up from an unrelated manual hold.
  const { data: lead } = await supabase
    .from('leads')
    .select('id, organization_id, first_name, last_name, phone_formatted, hold_until, closing_follow_up_at')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })

  const update: Record<string, unknown> = { closing_updated_at: new Date().toISOString() }
  if (parsed.data.temperature !== undefined) update.closing_temperature = parsed.data.temperature
  if (parsed.data.nextStep !== undefined) update.closing_next_step = parsed.data.nextStep
  if (parsed.data.followUpAt !== undefined) update.closing_follow_up_at = parsed.data.followUpAt
  if (parsed.data.reason !== undefined) update.primary_objection = parsed.data.reason

  // Keep state coherent: a temperature moved AWAY from 'deliberating' (and not
  // simultaneously setting a new date) clears the stale follow-up timer, so a
  // reactivated deal doesn't stay muted from the live queue.
  if (
    parsed.data.temperature !== undefined &&
    parsed.data.temperature !== 'deliberating' &&
    parsed.data.followUpAt === undefined
  ) {
    update.closing_follow_up_at = null
  }

  const { data: updated, error } = await supabase
    .from('leads')
    .update(update)
    .eq('id', id)
    .eq('organization_id', orgId)
    .select('id, closing_temperature, closing_next_step, closing_updated_at, closing_follow_up_at, primary_objection')
    .single()

  if (error) {
    return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  }

  // ── Follow-up ⇒ Do-Not-Disturb ────────────────────────────────────────────
  // A follow-up date is a promise to leave the patient alone until then, so a
  // deliberating deal with a future follow-up date is put on hold: the hold
  // choke point (src/lib/leads/hold.ts) then suppresses every automated dial,
  // text, and email until that date, while manual outreach and inbound still
  // flow. task-sweep clears the hold when the date passes, at which point the
  // deliberating_due follow-up task comes due and outreach resumes.
  //
  // We only clear a hold this flow itself placed (hold_until === the old
  // follow-up date); a manual hold a rep set for another reason is never touched.
  try {
    const decision = decideFollowUpHold({
      newTemperature: updated.closing_temperature as string | null,
      newFollowUpAt: updated.closing_follow_up_at as string | null,
      oldHoldUntil: (lead as { hold_until: string | null }).hold_until,
      oldFollowUpAt: (lead as { closing_follow_up_at: string | null }).closing_follow_up_at,
    })

    if (decision.action === 'set') {
      const leadName = leadDisplayName({
        first_name: decryptField((lead as { first_name: string | null }).first_name),
        last_name: decryptField((lead as { last_name: string | null }).last_name),
        phone_formatted: decryptField((lead as { phone_formatted: string | null }).phone_formatted),
      })
      await setLeadHold(supabase, {
        organizationId: orgId,
        leadId: id,
        leadName,
        holdUntil: decision.holdUntil,
        reason: (updated.closing_next_step as string | null) ?? 'Deliberating — paused until follow-up',
        userId: profile.id,
      })
    } else if (decision.action === 'clear') {
      // Left deliberating, or the follow-up date was cleared: release the hold
      // we placed so the reactivated deal is no longer muted from automation.
      await clearLeadHold(supabase, { organizationId: orgId, leadId: id, via: 'manual', userId: profile.id })
    }
  } catch (err) {
    // The closing edit already committed; a hold-sync failure must not fail the
    // request. Log and move on — the rep can set/clear the hold manually.
    logger.warn('Closing: follow-up hold sync failed', {
      leadId: id,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return NextResponse.json({ lead: updated })
}
