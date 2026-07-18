/**
 * Twilio async Answering Machine Detection callback for browser/bridge calls.
 *
 * POST /api/voice/amd?voiceCallId=… — fired once per dialed lead leg, out-of-band
 * from the call itself (see dialLeadIntoConference), carrying `AnsweredBy`.
 *
 * Why this is its own route rather than a branch of /api/voice/status: it is a
 * different Twilio callback with a different lifecycle. It fires MID-CALL, the
 * moment AMD decides — typically seconds after answer and well before the
 * `completed` status callback. Folding it into the status route would mean
 * disambiguating two unrelated payloads that both carry CallSid.
 *
 * That ordering is also why we do not touch `status` here. `voice_calls.status`
 * tracks the telephony lifecycle, and the `completed` callback lands after us —
 * writing status='voicemail' would simply be overwritten seconds later. Voicemail
 * lives in `outcome` + `answered_by`, which nothing downstream clobbers.
 */

import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/server'
import { validateTwilioWebhook, sendSMSToLead } from '@/lib/messaging/twilio'
import { isMachineAnsweredBy } from '@/lib/voice/post-call-review'
import { decryptLeadPII } from '@/lib/encryption'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  // Twilio signs the full URL including ?voiceCallId= — reconstruct it exactly.
  const url = new URL(request.url)
  const proto = request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '')
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || url.host
  const publicUrl = `${proto}://${host}${url.pathname}${url.search}`

  const form = await request.formData()
  const params: Record<string, string> = {}
  for (const [k, v] of form.entries()) params[k] = typeof v === 'string' ? v : ''

  const signature = request.headers.get('x-twilio-signature') || ''
  if (!validateTwilioWebhook(signature, publicUrl, params)) {
    logger.warn('Rejected voice AMD callback with invalid Twilio signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 403 })
  }

  const voiceCallId = url.searchParams.get('voiceCallId')
  if (!voiceCallId) return NextResponse.json({ ok: true })

  const answeredBy = params['AnsweredBy'] || null
  if (!answeredBy) return NextResponse.json({ ok: true })

  const supabase = createServiceClient()
  const { data: call } = await supabase
    .from('voice_calls')
    .select('id, organization_id, lead_id, outcome, call_mode, answered_by')
    .eq('id', voiceCallId)
    .maybeSingle()

  if (!call) return NextResponse.json({ ok: true })

  const durationMs = params['MachineDetectionDuration']
    ? parseInt(params['MachineDetectionDuration'], 10)
    : null

  const update: Record<string, unknown> = {
    answered_by: answeredBy,
    answered_by_ms: Number.isFinite(durationMs) ? durationMs : null,
  }

  // Only a machine verdict implies an outcome, and only when the rep has not
  // already dispositioned the call by hand. A human always outranks AMD: AMD is
  // a guess, and the rep was actually there.
  const machine = isMachineAnsweredBy(answeredBy)
  if (machine && !call.outcome) update.outcome = 'voicemail_left'

  // Claim the row: `.is('answered_by', null)` means only the FIRST callback to
  // land writes and gets a row back. Twilio retries this webhook on any non-2xx
  // or timeout, and the side effects below (timeline entry, follow-up text) must
  // not run twice — a duplicate text to a patient is the failure that matters.
  const { data: claimed } = await supabase
    .from('voice_calls')
    .update(update)
    .eq('id', call.id)
    .is('answered_by', null)
    .select('id')
    .maybeSingle()

  if (!claimed) {
    logger.info('Voice AMD: duplicate callback ignored', { call_id: call.id, answered_by: answeredBy })
    return NextResponse.json({ ok: true })
  }

  if (machine && call.lead_id) {
    await supabase.from('lead_activities').insert({
      organization_id: call.organization_id,
      lead_id: call.lead_id,
      activity_type: 'voice_call_voicemail',
      title: 'Call reached voicemail',
      metadata: {
        call_id: call.id,
        answered_by: answeredBy,
        detection_ms: durationMs,
        // Read from the row, not hardcoded: the same TwiML route serves both the
        // browser softphone and the ring-my-phone bridge, so both reach here.
        call_mode: call.call_mode,
      },
    })

    await maybeSendVoicemailFollowUp(supabase, {
      organizationId: call.organization_id,
      leadId: call.lead_id,
      callId: call.id,
    })
  }

  logger.info('Voice AMD verdict recorded', {
    call_id: call.id,
    answered_by: answeredBy,
    machine,
  })

  return NextResponse.json({ ok: true })
}

/**
 * Text the lead after a dial hits voicemail, so the touch isn't wasted on a
 * message they may never play. Opt-in per org and off by default — see the
 * migration for why.
 *
 * Deliberately NOT AI-generated: a fixed template needs no model call and cannot
 * hallucinate an offer. `sendSMSToLead` still applies the real gates (opt-out /
 * DNC, quiet hours, A2P), and we pass none of the bypass flags — this is
 * automated outreach, not a human 1:1 reply.
 *
 * Best-effort: a failed text must never fail Twilio's callback, or Twilio retries
 * the whole webhook.
 */
async function maybeSendVoicemailFollowUp(
  supabase: SupabaseClient,
  args: { organizationId: string; leadId: string; callId: string }
): Promise<void> {
  try {
    const { data: org } = await supabase
      .from('organizations')
      .select('name, voice_voicemail_followup_sms_enabled, voice_voicemail_followup_sms_body')
      .eq('id', args.organizationId)
      .maybeSingle()

    if (!org?.voice_voicemail_followup_sms_enabled) return

    const template = (org.voice_voicemail_followup_sms_body || '').trim()
    if (!template) return

    const { data: leadRow } = await supabase
      .from('leads')
      .select('id, first_name, phone, sms_opt_out')
      .eq('id', args.leadId)
      .maybeSingle()
    if (!leadRow) return

    // phone is encrypted at rest — sendSMSToLead needs plaintext E.164.
    const lead = decryptLeadPII(leadRow as Record<string, unknown>) as {
      first_name?: string | null
      phone?: string | null
      sms_opt_out?: boolean | null
    }

    // Cheap pre-check to skip obvious no-ops; sendSMSToLead re-checks for real.
    if (!lead.phone || lead.sms_opt_out) return

    const body = template
      .replace(/\{first_name\}/g, lead.first_name || 'there')
      .replace(/\{practice_name\}/g, org.name || 'our office')

    const res = await sendSMSToLead({
      supabase,
      leadId: args.leadId,
      to: lead.phone,
      body,
      caller: 'voicemail_followup',
    })

    logger.info('Voicemail follow-up SMS', {
      call_id: args.callId,
      lead_id: args.leadId,
      sent: res.sent,
      reason: res.sent ? undefined : res.reason,
    })
  } catch (err) {
    logger.warn('Voicemail follow-up SMS threw (non-fatal)', {
      call_id: args.callId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
