import twilio from 'twilio'
import type { SupabaseClient } from '@supabase/supabase-js'
import { assertConsent, logConsentViolation, type ConsentDenyReason } from '@/lib/consent/gate'
import { checkCompliance } from '@/lib/ai/compliance-filter'
import { checkSendWindow } from '@/lib/campaigns/send-window'
import { isFlagEnabled } from '@/lib/org/flags'
import { isSendAllowed, messagingDryRun } from '@/lib/messaging/test-allowlist'
import { recordSmsEstimate } from '@/lib/billing/cost-events'
import { logger } from '@/lib/logger'

// TCPA federal quiet hours: no telemarketing before 8am or after 9pm local time.
const TCPA_START_HOUR = 8
const TCPA_END_HOUR = 21

function getClient() {
  return twilio(
    process.env.TWILIO_ACCOUNT_SID!,
    process.env.TWILIO_AUTH_TOKEN!
  )
}

/**
 * Low-level SMS send. Bypasses the consent gate.
 * Only use for system-internal sends (verification codes, staff alerts) where there is no lead.
 * For any lead-facing message, use sendSMSToLead() so consent is enforced.
 */
export async function sendSMS(to: string, body: string): Promise<{ sid: string; status: string }> {
  // DRY-RUN hard clamp (strongest guard, checked first): when MESSAGING_DRY_RUN is
  // set, nothing physically leaves the system — to anyone. This is the choke point
  // every SMS path funnels through, so a smoke test or stray script cannot reach a
  // real number regardless of consent, flags, or recipient. See test-allowlist.ts.
  if (messagingDryRun()) {
    logger.warn('MESSAGING_DRY_RUN active — SMS suppressed (not sent)', {
      last4: to.replace(/[^0-9]/g, '').slice(-4),
    })
    return { sid: 'dry-run', status: 'blocked' }
  }

  // TEST-MODE hard clamp: when TEST_SEND_ALLOWLIST is set, refuse any recipient
  // not on the list. This is the single lowest-level choke point — every SMS path
  // (sendSMSToLead, crons, agent tools, raw transactional sends) funnels here — so
  // no real patient can be reached while AI workflows are under test.
  if (!isSendAllowed(to)) {
    logger.warn('TEST_SEND_ALLOWLIST active — blocked SMS to non-allowlisted recipient', {
      last4: to.replace(/[^0-9]/g, '').slice(-4),
    })
    return { sid: 'blocked-by-test-allowlist', status: 'blocked' }
  }

  // Prefer routing through the Messaging Service: for US A2P 10DLC the service is
  // what's bound to the approved Campaign and the registered sender pool, so the
  // carrier maps traffic correctly (avoids error 30034 — unregistered number).
  // Fall back to the raw from-number when no service is configured (local dev,
  // non-US destinations, or system OTP sends).
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID
  const message = await getClient().messages.create({
    body,
    to,
    ...(messagingServiceSid
      ? { messagingServiceSid }
      : { from: process.env.TWILIO_PHONE_NUMBER! }),
  })

  return {
    sid: message.sid,
    status: message.status,
  }
}

export type SendSMSToLeadResult =
  | { sent: true; sid: string; status: string }
  | { sent: false; reason: ConsentDenyReason | 'compliance_blocked' | 'compliance_review_required' | 'quiet_hours' | 'us_sms_disabled' }

/**
 * SMS send with TCPA consent enforcement (HARD GATE per brief Section 2.2).
 * If the lead has not granted SMS consent or has opted out, the send is refused
 * and a `consent_violation_prevented` row is written to the events table.
 *
 * Pass the resolved E.164 phone explicitly — this function does not look it up
 * (it's typically already decrypted in the caller's context).
 */
export async function sendSMSToLead(params: {
  supabase: SupabaseClient
  leadId: string
  to: string
  body: string
  caller?: string
  /** Set true if the body was AI-generated. Activates the compliance filter. */
  aiGenerated?: boolean
  /** When true, soft-flagged content (pricing claims, soft profanity) is also blocked. */
  blockOnReview?: boolean
  /**
   * Skip the TCPA quiet-hours gate. Only for human-authored, 1:1, customer-initiated
   * replies (e.g. a staff member answering a conversation) — NOT automated outreach.
   */
  bypassQuietHours?: boolean
}): Promise<SendSMSToLeadResult> {
  const decision = await assertConsent(params.supabase, params.leadId, 'sms')
  if (!decision.allowed) {
    await logConsentViolation(params.supabase, {
      organizationId: decision.lead?.organization_id ?? '',
      leadId: params.leadId,
      channel: 'sms',
      reason: decision.reason,
      bodyPreview: params.body,
      caller: params.caller,
    })
    return { sent: false, reason: decision.reason }
  }

  // Compliance filter: only run when explicitly requested (AI-generated content).
  // Manual staff sends bypass since a human authored the words.
  if (params.aiGenerated) {
    const check = checkCompliance(params.body, { channel: 'sms' })
    if (!check.allowed || (params.blockOnReview && check.requiresReview)) {
      await params.supabase.from('events').insert({
        organization_id: decision.lead?.organization_id,
        lead_id: params.leadId,
        event_type: 'compliance_block',
        payload: {
          channel: 'sms',
          caller: params.caller ?? null,
          reasons: check.reasons,
          requires_review: check.requiresReview,
          body_preview: params.body.slice(0, 200),
        },
        capi_status: 'na',
        gads_status: 'na',
      }).then(() => undefined, () => undefined)
      return { sent: false, reason: check.allowed ? 'compliance_review_required' : 'compliance_blocked' }
    }
  }

  // TCPA quiet hours (8am–9pm in the org's timezone). Checked last (after consent
  // and content compliance) so timing only blocks an otherwise-sendable message.
  // Covers every automated/marketing path centrally, not just campaigns.
  if (!params.bypassQuietHours) {
    const { data: org } = await params.supabase
      .from('organizations')
      .select('timezone')
      .eq('id', decision.lead.organization_id)
      .single()
    const tz = (org?.timezone as string) || 'America/New_York'
    const window = checkSendWindow({
      start_hour: TCPA_START_HOUR,
      end_hour: TCPA_END_HOUR,
      timezone: tz,
      days: [0, 1, 2, 3, 4, 5, 6], // quiet-hours apply every day; this gate is hours-only
    })
    if (!window.allowed) {
      await logConsentViolation(params.supabase, {
        organizationId: decision.lead.organization_id,
        leadId: params.leadId,
        channel: 'sms',
        reason: 'opted_out', // closest existing audit reason; payload notes quiet_hours via caller
        bodyPreview: params.body,
        caller: `${params.caller ?? 'sms'}:quiet_hours`,
      })
      return { sent: false, reason: 'quiet_hours' }
    }
  }

  // US A2P 10DLC hard gate (final pre-flight, after consent/compliance/quiet-hours):
  // until the org's 10DLC campaign is VERIFIED (flipped on via the `us_sms_enabled`
  // flag), refuse SMS to US (+1) numbers. Sending on an unregistered campaign risks
  // carrier error 30034 + TCPA exposure. Defense-in-depth — blocks the send path
  // itself, not just autopilot. Non-US numbers and system sends (sendSMS) are exempt.
  if (params.to.replace(/[\s\-()]/g, '').startsWith('+1')) {
    const usEnabled = await isFlagEnabled(params.supabase, decision.lead.organization_id, 'us_sms_enabled')
    if (!usEnabled) {
      await logConsentViolation(params.supabase, {
        organizationId: decision.lead.organization_id,
        leadId: params.leadId,
        channel: 'sms',
        reason: 'opted_out', // closest existing audit reason; caller notes the real cause
        bodyPreview: params.body,
        caller: `${params.caller ?? 'sms'}:us_sms_disabled`,
      })
      return { sent: false, reason: 'us_sms_disabled' }
    }
  }

  const result = await sendSMS(params.to, params.body)

  // Record an estimated SMS cost the moment the message leaves. The reconcile-costs cron later
  // upgrades this in place to the real Twilio price. Skipped for test-allowlist blocks (no
  // real send occurred, so there is no cost). Fire-and-forget — never blocks the send.
  if (result.status !== 'blocked') {
    void recordSmsEstimate(params.supabase, {
      organizationId: decision.lead.organization_id,
      sid: result.sid,
      body: params.body,
      leadId: params.leadId,
    })
  }

  return { sent: true, sid: result.sid, status: result.status }
}

export function validateTwilioWebhook(
  signature: string,
  url: string,
  params: Record<string, string>
): boolean {
  return twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN!,
    signature,
    url,
    params
  )
}
