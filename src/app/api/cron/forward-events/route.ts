/**
 * Events-queue forwarder.
 *
 * Reads pending rows from the `events` table and dispatches them to:
 *   - Meta Conversions API   (via existing connector)
 *   - Google Ads conversions (via existing connector)
 *
 * Each row carries its own per-target status (`capi_status`, `gads_status`) so the
 * two destinations are tracked independently and a failure on one doesn't cause
 * re-sends to the other.
 *
 * This decouples event production (form webhook, Cal webhook, dormant sweep, EHR
 * webhook in Phase 3) from delivery — failures retry on the next sweep instead
 * of blocking the request path. This is the Inngest replacement called out in
 * the plan (we're keeping the homegrown executor pattern).
 *
 * Brief reference: §3.3 "Build an events → CAPI queue ... so failures retry and don't block".
 *
 * Schedule: every 5 minutes (vercel.json).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { dispatchConnectorEvent } from '@/lib/connectors'
import { buildConnectorLeadData } from '@/lib/connectors'
import type { ConnectorEvent, ConnectorEventType } from '@/lib/connectors'

const BATCH_SIZE = 50
const MAX_RETRIES = 5

// Map our event_type values onto the connector dispatcher's ConnectorEventType.
// Events we don't forward are tagged 'na' so they're skipped on subsequent runs.
const FORWARDABLE: Record<string, ConnectorEventType> = {
  'lead.created': 'lead.created',
  'lead.qualified': 'lead.qualified',
  'lead.scored': 'lead.scored',
  'lead.booking.created': 'consultation.scheduled',
  'lead.booking.rescheduled': 'consultation.scheduled',
  'lead.treatment_planned': 'treatment.presented',
  'lead.treatment_accepted': 'treatment.accepted',
  'lead.treatment_completed': 'treatment.completed',
  'lead.payment.received': 'payment.received',
  // 'lead.dormant.flagged' / 'consent_violation_prevented' / 'compliance_block' / 'lead.booking.cancelled'
  // are intentionally NOT forwarded — internal-only events.
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()

  // Pull the next batch of events that have at least one pending forwarder.
  // Order by occurred_at ASC so we work the queue in arrival order.
  const { data: pending, error } = await supabase
    .from('events')
    .select('id, organization_id, lead_id, event_type, payload, occurred_at, capi_status, gads_status')
    .or('capi_status.eq.pending,gads_status.eq.pending')
    .order('occurred_at', { ascending: true })
    .limit(BATCH_SIZE)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!pending || pending.length === 0) {
    return NextResponse.json({ processed: 0 })
  }

  type PendingEvent = {
    id: string
    organization_id: string
    lead_id: string | null
    event_type: string
    payload: Record<string, unknown>
    occurred_at: string
    capi_status: string
    gads_status: string
  }

  let processed = 0
  let capiSent = 0
  let gadsSent = 0
  let skipped = 0

  for (const ev of pending as PendingEvent[]) {
    processed++

    // Tag non-forwardable events so we don't keep picking them up.
    const mapped = FORWARDABLE[ev.event_type]
    if (!mapped || !ev.lead_id) {
      await supabase
        .from('events')
        .update({
          capi_status: 'na',
          capi_attempted_at: new Date().toISOString(),
          gads_status: 'na',
          gads_attempted_at: new Date().toISOString(),
        })
        .eq('id', ev.id)
      skipped++
      continue
    }

    // Hydrate the lead so the connector has full context (PII decryption happens
    // inside buildConnectorLeadData).
    const { data: lead } = await supabase
      .from('leads')
      .select('*')
      .eq('id', ev.lead_id)
      .single()

    if (!lead) {
      await supabase
        .from('events')
        .update({
          capi_status: 'failed',
          capi_attempted_at: new Date().toISOString(),
          gads_status: 'failed',
          gads_attempted_at: new Date().toISOString(),
        })
        .eq('id', ev.id)
      continue
    }

    const connectorLead = buildConnectorLeadData(lead as Record<string, unknown>)

    // For value-bearing events emitted by EHR sync (treatment_accepted/_completed/payment.received),
    // the per-procedure or per-invoice $ amount lives in payload.value, NOT on the lead row
    // (a single lead can produce many such events with different values). Copy the payload value
    // onto the lead snapshot we hand the connector so Meta CAPI / Google Ads pick up the right
    // conversion value without having to special-case event types in every connector.
    const payloadValue = typeof ev.payload?.value === 'number' ? (ev.payload.value as number) : null
    if (payloadValue !== null && payloadValue > 0) {
      if (mapped === 'payment.received' || mapped === 'treatment.completed') {
        connectorLead.actual_revenue = payloadValue
      } else if (mapped === 'treatment.accepted' || mapped === 'treatment.presented') {
        connectorLead.treatment_value = payloadValue
      }
    }

    const connectorEvent: ConnectorEvent = {
      type: mapped,
      organizationId: ev.organization_id,
      leadId: ev.lead_id,
      timestamp: ev.occurred_at,
      data: {
        lead: connectorLead,
        metadata: ev.payload,
      },
    }

    // dispatchConnectorEvent runs ALL enabled connectors for the org in parallel
    // and returns per-connector results. We translate those into per-target status
    // updates on the event row.
    const results = await dispatchConnectorEvent(supabase, connectorEvent)

    const updates: Record<string, unknown> = {}

    if (ev.capi_status === 'pending') {
      const meta = results.find((r) => r.connector === 'meta_capi')
      if (meta) {
        if (meta.success) {
          updates.capi_status = 'sent'
          capiSent++
        } else {
          // Soft retry: keep status pending up to MAX_RETRIES, then mark failed.
          const attempts = ((ev.payload?._capi_attempts as number) || 0) + 1
          updates.capi_status = attempts >= MAX_RETRIES ? 'failed' : 'pending'
          updates.payload = { ...ev.payload, _capi_attempts: attempts, _capi_last_error: meta.error }
        }
        updates.capi_attempted_at = new Date().toISOString()
      } else {
        // No Meta connector configured for this org — mark skipped permanently.
        updates.capi_status = 'skipped'
        updates.capi_attempted_at = new Date().toISOString()
      }
    }

    if (ev.gads_status === 'pending') {
      const gads = results.find((r) => r.connector === 'google_ads')
      if (gads) {
        if (gads.success) {
          updates.gads_status = 'sent'
          gadsSent++
        } else {
          const attempts = ((ev.payload?._gads_attempts as number) || 0) + 1
          updates.gads_status = attempts >= MAX_RETRIES ? 'failed' : 'pending'
          updates.payload = {
            ...((updates.payload as Record<string, unknown>) ?? ev.payload),
            _gads_attempts: attempts,
            _gads_last_error: gads.error,
          }
        }
        updates.gads_attempted_at = new Date().toISOString()
      } else {
        updates.gads_status = 'skipped'
        updates.gads_attempted_at = new Date().toISOString()
      }
    }

    await supabase.from('events').update(updates).eq('id', ev.id)
  }

  return NextResponse.json({
    processed,
    capi_sent: capiSent,
    gads_sent: gadsSent,
    skipped,
  })
}

export const GET = POST
