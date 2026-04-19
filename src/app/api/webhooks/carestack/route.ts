/**
 * CareStack webhook handler.
 *
 * CareStack sends real-time pushes for:
 *   - Appointment events     (Status / Scheduled / Rescheduled / Updated)
 *   - Periodontal Chart      (Add / Update / Delete) — not consumed today
 *   - Referral Document      (ReferralUpdated)       — not consumed today
 *   - Patient events         (PatientAdd / PatientModify)
 *   - Online Appointment Msg (AppointmentMessageAdd) — incoming online booking, becomes a LEAD
 *
 * Signature: HMAC-SHA256 of the request body, prefixed by the AccountId bytes,
 * base64-decoded secret key (per CareStack code sample). Header: CareStack-Signature: v1=<hex>
 * Account header: CareStack-AccountId: <int>
 *
 * Per the CareStack docs: registration is initiated by emailing their tech ops
 * with the URL + action + vendor name. CareStack provides a per-account secret
 * which we store in connector_configs.credentials.webhook_secret.
 *
 * Brief reference: PDF "CareStack Webhooks" §"Validating the Data".
 */

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { upsertCareStackPatient } from '@/lib/ehr/carestack/match'
import { logger } from '@/lib/logger'

type CareStackEvent = {
  id?: string
  event?: string
  data?: Record<string, unknown> & { Timestamp?: string | number }
}

export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.webhook)
  if (rlError) return rlError

  const rawBody = await request.text()
  const signature = request.headers.get('carestack-signature') || ''
  const accountIdHeader = request.headers.get('carestack-accountid') || ''

  if (!signature || !accountIdHeader) {
    return new NextResponse('Missing CareStack-Signature or CareStack-AccountId', { status: 401 })
  }

  // Find the org with this CareStack accountId in connector_configs.credentials.account_id.
  const supabase = createServiceClient()
  const { data: cfg } = await supabase
    .from('connector_configs')
    .select('organization_id, credentials, enabled')
    .eq('connector_type', 'carestack')
    .eq('enabled', true)
    .filter('credentials->>account_id', 'eq', accountIdHeader)
    .maybeSingle()

  if (!cfg) {
    return new NextResponse('No CareStack integration configured for this AccountId', { status: 401 })
  }

  const secret = (cfg.credentials as { webhook_secret?: string })?.webhook_secret
  if (!secret) {
    return new NextResponse('Webhook secret not configured', { status: 401 })
  }

  if (!verifyCareStackSignature(rawBody, signature, accountIdHeader, secret)) {
    return new NextResponse('Invalid CareStack signature', { status: 401 })
  }

  const organizationId = cfg.organization_id as string

  // Optional staleness check (recommended ≤ 5 min per their code sample).
  let event: CareStackEvent
  try {
    event = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const ts = Number(event.data?.Timestamp)
  if (Number.isFinite(ts) && Math.abs(Date.now() / 1000 - ts) > 5 * 60) {
    logger.warn('Stale CareStack webhook', { organizationId, event: event.event, ts })
    // Accept but flag — we don't reject because clock drift on either side can happen.
  }

  const eventName = event.event || ''

  try {
    switch (eventName) {
      // ── Appointment events ──────────────────────────────────────
      case 'Status':
      case 'Scheduled':
      case 'Updated':
      case 'Rescheduled': {
        await handleAppointmentEvent(supabase, organizationId, eventName, event.data || {})
        break
      }

      // ── Patient events ──────────────────────────────────────────
      case 'PatientAdd':
      case 'PatientModify': {
        await handlePatientEvent(supabase, organizationId, eventName, event.data || {})
        break
      }

      // ── Online appointment request → LEAD ──────────────────────
      case 'AppointmentMessageAdd': {
        await handleOnlineAppointmentMessage(supabase, organizationId, event.data || {})
        break
      }

      // ── Periodontal / Referral — store-and-no-op for now ───────
      case 'Add':
      case 'Update':
      case 'Delete':
      case 'ReferralUpdated': {
        await emitInternalEvent(supabase, organizationId, null, `carestack.${eventName.toLowerCase()}`, event.data || {})
        break
      }

      default: {
        logger.info('Unknown CareStack event', { organizationId, event: eventName })
      }
    }
  } catch (err) {
    logger.error('CareStack webhook handler failed', {
      organizationId,
      event: eventName,
      err: err instanceof Error ? err.message : String(err),
    })
    // Return 200 anyway so CareStack doesn't retry-storm; the error is logged for follow-up.
  }

  return NextResponse.json({ ok: true })
}

// ── handlers ────────────────────────────────────────────────────

async function handleAppointmentEvent(
  supabase: ReturnType<typeof createServiceClient>,
  organizationId: string,
  trigger: string,
  data: Record<string, unknown>
): Promise<void> {
  // Per the CareStack sample, the Rescheduled event includes Old/NewAppointment
  // pairs; other events include AppointmentId + PatientId at the top level.
  const newApt = (data.NewAppointment as Record<string, unknown> | undefined) || data
  const oldApt = data.OldAppointment as Record<string, unknown> | undefined

  const ehrAppointmentId = newApt.AppointmentId ?? newApt.appointmentId
  const ehrPatientId = newApt.PatientId ?? newApt.patientId

  if (!ehrAppointmentId) return

  // Resolve our patient row (creates a stub if first time).
  let leadId: string | null = null
  let patientRowId: string | null = null
  if (ehrPatientId !== undefined && ehrPatientId !== null) {
    const match = await upsertCareStackPatient(supabase, organizationId, {
      ehr_patient_id: ehrPatientId as number,
    })
    leadId = match.leadId
    patientRowId = match.patientRowId
  }

  // Best-effort: link or create an appointments row keyed on (org, source, external_id).
  const { data: existing } = await supabase
    .from('appointments')
    .select('id, status')
    .eq('organization_id', organizationId)
    .eq('external_source', 'carestack')
    .eq('external_id', String(ehrAppointmentId))
    .maybeSingle()

  if (!existing && leadId) {
    await supabase.from('appointments').insert({
      organization_id: organizationId,
      lead_id: leadId,
      patient_id: patientRowId,
      type: 'consultation',
      status: 'scheduled',
      scheduled_at: (newApt.DateTime as string) || new Date().toISOString(),
      duration_minutes: (newApt.Duration as number) || 60,
      external_id: String(ehrAppointmentId),
      external_source: 'carestack',
      metadata: { source: 'carestack', trigger, raw: data },
    })
  } else if (existing) {
    await supabase.from('appointments')
      .update({
        patient_id: patientRowId ?? undefined,
        metadata: { source: 'carestack', trigger, raw: data },
      })
      .eq('id', existing.id)
  }

  await emitInternalEvent(supabase, organizationId, leadId, `carestack.appointment.${trigger.toLowerCase()}`, {
    ehr_appointment_id: ehrAppointmentId,
    ehr_patient_id: ehrPatientId,
    old_appointment: oldApt ?? null,
    new_appointment: newApt,
  })
}

async function handlePatientEvent(
  supabase: ReturnType<typeof createServiceClient>,
  organizationId: string,
  trigger: string,
  data: Record<string, unknown>
): Promise<void> {
  const patientId = data.PatientId ?? data.patientId
  if (!patientId) return

  // Webhook payload is intentionally minimal. We could fetch full patient via
  // /api/v1.0/patients/{id} here, but that needs OAuth — defer to the daily
  // patient sync to avoid hammering CareStack on every modify event.
  await upsertCareStackPatient(supabase, organizationId, { ehr_patient_id: patientId as number })

  await emitInternalEvent(supabase, organizationId, null, `carestack.patient.${trigger.toLowerCase()}`, data)
}

async function handleOnlineAppointmentMessage(
  supabase: ReturnType<typeof createServiceClient>,
  organizationId: string,
  data: Record<string, unknown>
): Promise<void> {
  // This is an inbound lead — same shape as a website form submission. We forward it
  // straight into the form webhook handler logic by posting to ourselves. That keeps
  // form-creation logic in one place (consent capture, AI scoring, speed-to-lead, CAPI event).
  //
  // Map CareStack's AppointmentMessageAdd payload to our webhookLeadSchema.
  const firstName = (data.FirstName as string) || 'Online'
  const lastName = (data.LastName as string) || 'Booking'
  const email = (data.Email as string) || undefined
  const mobile = (data.Mobile as string) || undefined
  const notes = (data.Notes as string) || undefined
  const preferredDate = (data.PreferredDate as string) || undefined

  // Insert lead directly (skip the HTTP round trip — we have the service client).
  // Mirrors what /api/webhooks/form/route.ts does, minus dedupe (we accept the dupe risk
  // here since CareStack's AppointmentMessageAdd is itself idempotent on the patient side).
  const phoneFormatted = mobile ? toE164(mobile) : null

  // Resolve default pipeline stage (mirrors form webhook).
  const { data: defaultStage } = await supabase
    .from('pipeline_stages')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('is_default', true)
    .maybeSingle()

  const { data: lead, error } = await supabase
    .from('leads')
    .insert({
      organization_id: organizationId,
      first_name: firstName,
      last_name: lastName,
      email: email ?? null,
      phone: mobile ?? null,
      phone_formatted: phoneFormatted,
      notes: notes ?? null,
      stage_id: defaultStage?.id ?? null,
      status: 'new',
      source_type: 'online_booking',
      utm_source: 'carestack',
      utm_medium: 'online_appointment',
      // CareStack doesn't capture marketing consent — we treat the booking action
      // itself as transactional, but DON'T grant marketing consent.
      sms_consent: false,
      email_consent: false,
      custom_fields: {
        carestack_account_id: data.AccountId,
        carestack_location_id: data.LocationId,
        preferred_date: preferredDate,
      },
    })
    .select('id')
    .single()

  if (error || !lead) {
    logger.error('Failed to insert lead from CareStack online appointment', { err: error?.message })
    return
  }

  // Emit lead.created so the forwarder ships it to Meta CAPI / Google Ads as a Lead conversion.
  await emitInternalEvent(supabase, organizationId, lead.id as string, 'lead.created', {
    source: 'carestack_online_appointment',
    preferred_date: preferredDate,
    raw: data,
  })
}

async function emitInternalEvent(
  supabase: ReturnType<typeof createServiceClient>,
  organizationId: string,
  leadId: string | null,
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  await supabase.from('events').insert({
    organization_id: organizationId,
    lead_id: leadId,
    event_type: eventType,
    payload,
    occurred_at: new Date().toISOString(),
  })
}

// ── signature verification ──────────────────────────────────────

/**
 * Replicates CareStack's HMAC-SHA256 ValidateSignature pattern from their docs:
 *   key = base64-decoded secret
 *   hmac.TransformBlock(prefix=accountIdBytes)
 *   hmac.ComputeHash(bodyBytes)
 *   expected = "v1=" + hex(hmac)
 *
 * In practice TransformBlock accumulates the prefix into the hash state, then the
 * final ComputeHash on the body produces a digest equivalent to HMAC(secret, accountIdBytes || bodyBytes).
 */
function verifyCareStackSignature(
  body: string,
  signature: string,
  accountId: string,
  secretBase64: string
): boolean {
  let secret: Buffer
  try {
    secret = Buffer.from(secretBase64, 'base64')
    if (secret.length === 0) {
      // Fall back to treating the secret as a raw string if it isn't base64 (some configs)
      secret = Buffer.from(secretBase64, 'utf8')
    }
  } catch {
    secret = Buffer.from(secretBase64, 'utf8')
  }

  const hmac = crypto.createHmac('sha256', secret)
  hmac.update(Buffer.from(accountId, 'utf8'))
  hmac.update(Buffer.from(body, 'utf8'))
  const expected = `v1=${hmac.digest('hex')}`

  // Length must match for timingSafeEqual; otherwise it's already a fail.
  if (expected.length !== signature.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  } catch {
    return false
  }
}

function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (!digits) return phone
  if (phone.startsWith('+')) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return `+${digits}`
}
