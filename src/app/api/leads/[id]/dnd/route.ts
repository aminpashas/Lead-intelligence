/**
 * POST /api/leads/[id]/dnd — staff-facing per-channel Do-Not-Disturb toggle.
 *
 * The lead-initiated side of DND (a STOP reply, an email unsubscribe, a GHL DND
 * sync) already flows in through webhooks + /api/v1/consent and lands on the same
 * `*_opt_out` columns this route writes. This is the *staff* write path: a user
 * enabling/disabling DND on specific channels (or all) from the lead UI.
 *
 * DND is per-channel by construction — the request names the channels to change
 * and the others are left exactly as they were. Enforcement is already done: every
 * send path (twilio.ts / resend.ts / call-manager.ts) hard-blocks on these flags,
 * so this route only has to write the flag + leave a breadcrumb. The DB triggers
 * derive tri-state status and append the consent_log audit row.
 */
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { dndFields, type DndChannel } from '@/lib/consent/capture'

const bodySchema = z.object({
  channels: z.array(z.enum(['sms', 'email', 'call'])).min(1),
  enabled: z.boolean(),
})

export async function POST(
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
  const channels = parsed.data.channels as DndChannel[]
  const { enabled } = parsed.data

  // Confirm the lead exists in this org (RLS + explicit scope = defense in depth).
  const { data: lead } = await supabase
    .from('leads')
    .select('id, organization_id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })

  const update = dndFields(channels, enabled)

  const { data: updated, error } = await supabase
    .from('leads')
    .update(update)
    .eq('id', id)
    .eq('organization_id', orgId)
    .select('sms_opt_out, sms_opt_out_at, email_opt_out, email_opt_out_at, voice_opt_out, voice_opt_out_at, do_not_call')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Activity breadcrumb (best-effort; the consent_log audit row is written by the
  // DB trigger, so a logging failure here must never fail the toggle).
  try {
    await supabase.from('lead_activities').insert({
      organization_id: orgId,
      lead_id: id,
      activity_type: enabled ? 'dnd_enabled' : 'dnd_disabled',
      title: `Do Not Disturb ${enabled ? 'enabled' : 'lifted'} for ${channels.join(', ')}`,
      metadata: { channels, enabled, source: 'staff', actor: profile.id },
    })
  } catch {
    /* breadcrumb only */
  }

  return NextResponse.json({ ok: true, lead_id: id, channels, enabled, dnd: updated })
}
