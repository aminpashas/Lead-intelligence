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
import { fireAndForgetEnsureContract } from '@/lib/contracts/orchestrator'

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

// ── T3.3 dual-CAPI gate ─────────────────────────────────────────────
// The sibling "Dion Growth Studio" (DGS) system receives a writeback from LI
// (SQL trigger notify_growth_studio_lead_event) and fires Meta CAPI itself for
// two down-funnel conversions: BookedConsult and TreatmentAccepted. DGS holds
// the original ad click identifiers (fbc/fbp/gclid) that LI usually lacks, so
// when the writeback is enabled DGS *owns* those Meta conversions and LI must
// NOT also fire them — otherwise Meta double-counts.
//
// DGS does NOT do Google Ads, and DGS does NOT fire any of the other event
// types, so for the DGS-owned set we still dispatch Google Ads from LI and we
// keep firing everything else (lead.created/qualified/scored/treatment_planned/
// payment.received) on BOTH connectors unchanged.
const DGS_OWNED_META_EVENT_TYPES = new Set<string>([
  'lead.booking.created', // → BookedConsult
  'lead.booking.rescheduled', // → BookedConsult
  'lead.treatment_accepted', // → TreatmentAccepted
  'lead.treatment_completed', // → TreatmentAccepted
])

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()

  // T3.3: load the global DGS writeback switch once per sweep. When enabled, DGS
  // owns the down-funnel Meta CAPI conversions (see DGS_OWNED_META_EVENT_TYPES).
  const { data: dgsConfig } = await supabase
    .from('growth_studio_webhook_config')
    .select('enabled')
    .limit(1)
    .maybeSingle()
  const dgsOwnsDownfunnelCapi = !!dgsConfig?.enabled

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

    // T3.3: when the gate is on and this is a DGS-owned event, exclude Meta CAPI
    // from the dispatch entirely (Google Ads still fires — DGS does not do it).
    // The Meta network call genuinely does not happen because we restrict the
    // dispatcher to only the google_ads connector.
    const capiSkippedForDgs =
      dgsOwnsDownfunnelCapi && DGS_OWNED_META_EVENT_TYPES.has(ev.event_type)

    // dispatchConnectorEvent runs the enabled connectors for the org in parallel
    // and returns per-connector results. We translate those into per-target status
    // updates on the event row.
    const results = await dispatchConnectorEvent(
      supabase,
      connectorEvent,
      capiSkippedForDgs ? { only: ['google_ads'] } : undefined
    )

    const updates: Record<string, unknown> = {}

    if (ev.capi_status === 'pending' && capiSkippedForDgs) {
      // T3.3: Meta CAPI was deliberately not dispatched for this DGS-owned event.
      // Mark it skipped with a clear reason so the row isn't picked up again.
      updates.capi_status = 'skipped'
      updates.capi_attempted_at = new Date().toISOString()
      updates.payload = { ...ev.payload, _capi_skip_reason: 'dgs_owned' }
    } else if (ev.capi_status === 'pending') {
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

    // Side effect: when CareStack reports treatment accepted, kick off contract draft
    // for the most recent clinical case on this lead. Gated by org settings.
    if (
      ev.event_type === 'lead.treatment_accepted' &&
      !(ev.payload?._contract_orchestrated === true)
    ) {
      try {
        const { data: org } = await supabase
          .from('organizations')
          .select('settings')
          .eq('id', ev.organization_id)
          .single()
        const autoDraft =
          (org?.settings as { contracts?: { auto_draft_on_ehr_accept?: boolean } })?.contracts
            ?.auto_draft_on_ehr_accept !== false
        if (autoDraft) {
          const { data: caseRow } = await supabase
            .from('clinical_cases')
            .select('id')
            .eq('lead_id', ev.lead_id)
            .eq('organization_id', ev.organization_id)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()
          if (caseRow) {
            fireAndForgetEnsureContract({
              organizationId: ev.organization_id,
              caseId: caseRow.id,
              actorType: 'system',
            })
            // Mark payload so we don't retry on subsequent sweeps
            await supabase
              .from('events')
              .update({ payload: { ...ev.payload, _contract_orchestrated: true } })
              .eq('id', ev.id)
          }
        }
      } catch (err) {
        console.error('[forward-events] contract orchestrate failed', err)
      }
    }
  }

  return NextResponse.json({
    processed,
    capi_sent: capiSent,
    gads_sent: gadsSent,
    skipped,
  })
}

export const GET = POST
