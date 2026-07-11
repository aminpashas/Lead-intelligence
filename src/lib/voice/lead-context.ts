/**
 * Lead history context for the hosted voice agent.
 *
 * WHY THIS EXISTS: the Retell hosted agent only knows what we pass in
 * `retell_llm_dynamic_variables` at call time. Name + date awareness alone make
 * it recognize the caller but leave it amnesiac — it can't reference the last
 * conversation, knows nothing about appointments already booked (or no-showed),
 * and re-asks questions the patient already answered. This module builds a
 * compact "what has happened with this patient" block shared by ALL call paths
 * (inbound webhook, manual dashboard call, campaign dialer) so the agent has
 * the same memory regardless of who initiated the call.
 *
 * The Retell dashboard prompt must reference the variables produced here:
 *   {{conversation_summary}} {{last_contact}} {{recent_messages}}
 *   {{upcoming_appointment}} {{appointment_history}} {{conversation_intent}}
 *   {{primary_objection}}
 *
 * PHI note: injecting these variables does NOT disclose anything by itself —
 * disclosure is governed by the prompt's identity-verification gate (DOB check
 * before PHI on inbound). The variables give the agent memory; the prompt
 * decides when it may speak from it.
 *
 * Budget: every value is length-clamped so the combined block stays well under
 * ~2k chars — dynamic variables are interpolated into the prompt on every turn,
 * so an unbounded transcript would bloat latency and cost.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptField } from '@/lib/encryption'

const DEFAULT_TZ = 'America/New_York'
const RECENT_MESSAGE_COUNT = 8
const MESSAGE_SNIPPET_CHARS = 160
const PAST_APPOINTMENT_COUNT = 3

export type LeadContextVariables = {
  conversation_summary: string
  conversation_intent: string
  primary_objection: string
  last_contact: string
  recent_messages: string
  recent_calls: string
  upcoming_appointment: string
  appointment_history: string
  /** Decrypted email on the lead record, '' when none — so the agent confirms
   *  instead of re-asking, and knows where confirmations will be sent. */
  email_on_file: string
}

const RECENT_CALL_COUNT = 3
const CALL_SUMMARY_CHARS = 220

function fmtDate(iso: string, tz: string, withTime = false): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
      timeZone: tz,
    }).format(new Date(iso))
  } catch {
    return new Date(iso).toDateString()
  }
}

function daysAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (diff <= 0) return 'today'
  if (diff === 1) return 'yesterday'
  return `${diff} days ago`
}

/** Human-readable appointment status ("no_show" → "no-show"). */
function fmtStatus(status: string | null): string {
  return (status || 'scheduled').replace(/_/g, '-')
}

/**
 * Build the shared history variables for a lead. Every query is best-effort:
 * a failure in any lookup degrades that variable to '' rather than blocking
 * the call (mirrors the non-blocking DB philosophy of the inbound webhook).
 */
export async function buildLeadContextVariables(
  supabase: SupabaseClient,
  leadId: string,
  organizationId: string,
  timezone?: string | null
): Promise<LeadContextVariables> {
  const tz = timezone?.trim() || DEFAULT_TZ
  const vars: LeadContextVariables = {
    conversation_summary: '',
    conversation_intent: '',
    primary_objection: '',
    last_contact: '',
    recent_messages: '',
    recent_calls: '',
    upcoming_appointment: '',
    appointment_history: '',
    email_on_file: '',
  }

  // ── Sweep-written recap + analysis flags (already on the lead row) ──
  try {
    const { data: lead } = await supabase
      .from('leads')
      .select(
        'conversation_summary, conversation_intent, primary_objection, last_contacted_at, email'
      )
      .eq('id', leadId)
      .eq('organization_id', organizationId)
      .single()

    if (lead) {
      vars.conversation_summary = (lead.conversation_summary as string) || ''
      vars.conversation_intent = (lead.conversation_intent as string) || ''
      vars.primary_objection = (lead.primary_objection as string) || ''
      if (lead.last_contacted_at) {
        const at = lead.last_contacted_at as string
        vars.last_contact = `${daysAgo(at)} (${fmtDate(at, tz)})`
      }
      if (lead.email) {
        vars.email_on_file = decryptField(lead.email as string) || (lead.email as string)
      }
    }
  } catch {
    // best-effort
  }

  // ── Recent cross-channel messages, oldest→newest so the agent reads a thread ──
  try {
    const { data: messages } = await supabase
      .from('messages')
      .select('direction, channel, body, created_at, sender_type')
      .eq('lead_id', leadId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(RECENT_MESSAGE_COUNT)

    if (messages?.length) {
      vars.recent_messages = messages
        .reverse()
        .map((m) => {
          const who = m.direction === 'inbound' ? 'Patient' : 'Practice'
          const body = ((m.body as string) || '').replace(/\s+/g, ' ').trim()
          const snippet =
            body.length > MESSAGE_SNIPPET_CHARS
              ? `${body.slice(0, MESSAGE_SNIPPET_CHARS)}…`
              : body
          return `${who} (${fmtDate(m.created_at as string, tz)}, ${m.channel}): ${snippet}`
        })
        .join('\n')
    }
  } catch {
    // best-effort
  }

  // ── Recent phone calls: transcripts live on voice_calls, NOT the messages
  // thread, so without this the agent is blind to what was said on previous
  // calls — including one that ended minutes ago. Summaries only (a raw
  // transcript would blow the prompt budget).
  try {
    const { data: calls } = await supabase
      .from('voice_calls')
      .select('direction, status, outcome, transcript_summary, started_at')
      .eq('lead_id', leadId)
      .eq('organization_id', organizationId)
      .not('started_at', 'is', null)
      .order('started_at', { ascending: false })
      .limit(RECENT_CALL_COUNT)

    if (calls?.length) {
      vars.recent_calls = calls
        .reverse()
        .map((c) => {
          const summary = ((c.transcript_summary as string) || '').replace(/\s+/g, ' ').trim()
          const clamped =
            summary.length > CALL_SUMMARY_CHARS ? `${summary.slice(0, CALL_SUMMARY_CHARS)}…` : summary
          const outcome = c.outcome ? ` [${fmtStatus(c.outcome as string)}]` : ''
          return `${fmtDate(c.started_at as string, tz)} (${c.direction} call)${outcome}: ${clamped || 'no summary recorded'}`
        })
        .join('\n')
    }
  } catch {
    // best-effort
  }

  // ── Appointments: the next one booked + how past ones went ──
  try {
    const nowIso = new Date().toISOString()
    const [{ data: upcoming }, { data: past }] = await Promise.all([
      supabase
        .from('appointments')
        .select('type, status, scheduled_at, location')
        .eq('lead_id', leadId)
        .eq('organization_id', organizationId)
        .gte('scheduled_at', nowIso)
        .in('status', ['scheduled', 'confirmed'])
        .order('scheduled_at', { ascending: true })
        .limit(1),
      supabase
        .from('appointments')
        .select('type, status, scheduled_at')
        .eq('lead_id', leadId)
        .eq('organization_id', organizationId)
        .lt('scheduled_at', nowIso)
        .order('scheduled_at', { ascending: false })
        .limit(PAST_APPOINTMENT_COUNT),
    ])

    if (upcoming?.[0]) {
      const a = upcoming[0]
      vars.upcoming_appointment = `${a.type} on ${fmtDate(a.scheduled_at as string, tz, true)} (${fmtStatus(a.status as string)})${a.location ? ` at ${a.location}` : ''}`
    }
    if (past?.length) {
      vars.appointment_history = past
        .map((a) => `${fmtDate(a.scheduled_at as string, tz)}: ${a.type} — ${fmtStatus(a.status as string)}`)
        .join('\n')
    }
  } catch {
    // best-effort
  }

  return vars
}
