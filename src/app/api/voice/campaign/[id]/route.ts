/**
 * Campaign detail — KPIs + per-lead communication.
 *
 * GET /api/voice/campaign/[id] — powers the campaign drill-down. KPIs are computed
 * from voice_calls (the source of truth) rather than the denormalized counters on
 * voice_campaigns, so "% called / responded" stay accurate even on the
 * live-transfer path (whose call-end handler doesn't bump those counters).
 *
 * "Responded" = an answered call that lasted a real beat (≥20s) or reached a
 * human/booking — i.e. a genuine engagement, not a 2-second pickup-and-hang-up.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { decryptLeadPII } from '@/lib/encryption'

const RESPONDED_MIN_SECONDS = 20
const LEAD_ROWS = 100
const CALL_ROWS = 400

function maskPhone(phone: string | null | undefined): string {
  if (!phone) return ''
  const digits = String(phone).replace(/\D/g, '')
  return digits.length >= 4 ? `••• ••• ${digits.slice(-4)}` : ''
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: campaignId } = await params
  const authClient = await createClient()
  const { orgId } = await resolveActiveOrg(authClient)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = createServiceClient()

  const { data: campaign } = await supabase
    .from('voice_campaigns')
    .select('*')
    .eq('id', campaignId)
    .eq('organization_id', orgId)
    .single()

  if (!campaign) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const callBase = () =>
    supabase.from('voice_calls').select('id', { count: 'exact', head: true }).eq('voice_campaign_id', campaignId)

  const [
    { count: totalLeads },
    { count: calledLeads },
    { count: dials },
    { count: answered },
    { count: responded },
    { count: sentToHeather },
    { count: booked },
    { count: noAnswerVm },
  ] = await Promise.all([
    supabase.from('voice_campaign_leads').select('id', { count: 'exact', head: true }).eq('voice_campaign_id', campaignId),
    supabase.from('voice_campaign_leads').select('id', { count: 'exact', head: true }).eq('voice_campaign_id', campaignId).gt('attempts', 0),
    callBase(),
    callBase().not('answered_at', 'is', null),
    callBase().not('answered_at', 'is', null).or(`duration_seconds.gte.${RESPONDED_MIN_SECONDS},transfer_bridged_at.not.is.null,outcome.eq.appointment_booked`),
    callBase().not('transfer_bridged_at', 'is', null),
    callBase().eq('outcome', 'appointment_booked'),
    callBase().in('outcome', ['no_answer', 'voicemail_left']),
  ])

  // Lead rows for the drill-down list.
  type LeadQueueRow = {
    lead_id: string
    status: string
    attempts: number | null
    last_attempt_at: string | null
    outcome: string | null
    lead: Record<string, unknown> | null
  }
  const { data: leadRowsData } = await supabase
    .from('voice_campaign_leads')
    .select('lead_id, status, attempts, last_attempt_at, outcome, lead:leads(id, first_name, last_name, phone_formatted)')
    .eq('voice_campaign_id', campaignId)
    .order('last_attempt_at', { ascending: false, nullsFirst: false })
    .limit(LEAD_ROWS)
  const leadRows = (leadRowsData || []) as unknown as LeadQueueRow[]

  // Calls for those same leads, stitched into per-lead timelines.
  const leadIds = leadRows.map((r: LeadQueueRow) => r.lead_id)
  const { data: callRows } = leadIds.length
    ? await supabase
        .from('voice_calls')
        .select('lead_id, status, outcome, duration_seconds, started_at, transfer_status, transfer_bridged_at, transcript_summary')
        .eq('voice_campaign_id', campaignId)
        .in('lead_id', leadIds)
        .order('started_at', { ascending: true })
        .limit(CALL_ROWS)
    : { data: [] }

  const callsByLead = new Map<string, unknown[]>()
  for (const c of callRows || []) {
    const arr = callsByLead.get(c.lead_id) || []
    arr.push({
      status: c.status,
      outcome: c.outcome,
      duration_seconds: c.duration_seconds,
      started_at: c.started_at,
      transfer_status: c.transfer_status,
      bridged: !!c.transfer_bridged_at,
      summary: c.transcript_summary,
    })
    callsByLead.set(c.lead_id, arr)
  }

  const leads = leadRows.map((r: LeadQueueRow) => {
    const lead = r.lead ? decryptLeadPII(r.lead as unknown as Record<string, unknown>) : null
    const first = (lead?.first_name as string) || ''
    const last = (lead?.last_name as string) || ''
    return {
      lead_id: r.lead_id,
      name: `${first} ${last}`.trim() || 'Unknown lead',
      phone: maskPhone(lead?.phone_formatted as string),
      status: r.status,
      attempts: r.attempts || 0,
      last_attempt_at: r.last_attempt_at,
      outcome: r.outcome,
      calls: callsByLead.get(r.lead_id) || [],
    }
  })

  const total = totalLeads || 0
  return NextResponse.json({
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      live_transfer_enabled: campaign.live_transfer_enabled,
      transfer_mode: campaign.transfer_mode,
      calls_per_hour: campaign.calls_per_hour,
      max_attempts_per_lead: campaign.max_attempts_per_lead,
      retry_delay_hours: campaign.retry_delay_hours,
      auto_enroll: !!(campaign.target_criteria as Record<string, unknown>)?.auto_enroll,
    },
    kpis: {
      total_leads: total,
      called: calledLeads || 0,
      called_pct: total > 0 ? Math.round(((calledLeads || 0) / total) * 100) : 0,
      dials: dials || 0,
      answered: answered || 0,
      responded: responded || 0,
      sent_to_heather: sentToHeather || 0,
      booked: booked || 0,
      no_answer_vm: noAnswerVm || 0,
    },
    leads,
  })
}
