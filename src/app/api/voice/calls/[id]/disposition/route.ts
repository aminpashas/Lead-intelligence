/**
 * PATCH /api/voice/calls/[id]/disposition — staff records the outcome of a call.
 *
 * Set after a browser softphone call ends (the widget prompts for it). Writes the
 * chosen outcome + optional notes onto the voice_calls row, org-scoped so a staffer
 * can only disposition their own org's calls. Kept separate from the Twilio status
 * callback so a human outcome is never clobbered by an automated status update.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'

const bodySchema = z.object({
  outcome: z.enum([
    'appointment_booked',
    'callback_requested',
    'interested',
    'not_interested',
    'wrong_number',
    'do_not_call',
    'voicemail_left',
    'no_answer',
    'technical_failure',
    'transferred',
  ]),
  notes: z.string().max(2000).optional(),
})

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const authClient = await createClient()

  // Effective org honors an agency_admin's entered client account. We then write
  // through the service client scoped to that org — voice_calls RLS keys on the
  // caller's HOME org, which would block an agency admin managing a client.
  const { orgId } = await resolveActiveOrg(authClient)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = bodySchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
  const { outcome, notes } = parsed.data

  const supabase = createServiceClient()
  const { data: updated, error } = await supabase
    .from('voice_calls')
    .update({ outcome, outcome_notes: notes ?? null })
    .eq('id', id)
    .eq('organization_id', orgId)
    .select('id, lead_id')
    .maybeSingle()

  if (error) return NextResponse.json({ error: 'Failed to save disposition' }, { status: 500 })
  if (!updated) return NextResponse.json({ error: 'Call not found' }, { status: 404 })

  // If the staffer marked do-not-call, honor it on the lead immediately.
  if (outcome === 'do_not_call') {
    await supabase.from('leads').update({ do_not_call: true }).eq('id', updated.lead_id).eq('organization_id', orgId)
  }

  return NextResponse.json({ ok: true })
}
