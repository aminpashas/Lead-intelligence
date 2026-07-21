/**
 * Inbound call flow — shared context building, routing policy, and TwiML.
 *
 * Three webhooks cooperate on one inbound call:
 *   /api/voice/inbound              — first contact: decide AI vs ring-agents vs voicemail
 *   /api/voice/inbound/dial-result  — the <Dial> action: agents answered, or fall back
 *   /api/voice/inbound/voicemail    — the <Record> action + transcription callback
 *
 * The org's policy (organizations.inbound_call_mode + the AI takeover toggles)
 * says which path a call takes; the business-hours window and who-to-ring both
 * come from the live-transfer config (voice_transfer_routes / voice_transfer_targets)
 * so there is exactly one place a practice defines its hours and its people.
 *
 * Everything here must be fast and failure-tolerant: Twilio is holding a live
 * caller while these run, so DB hiccups degrade (to the AI or voicemail) rather
 * than block the call.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildDateDynamicVariables } from '@/lib/ai/datetime-context'
import { buildLeadContextVariables } from '@/lib/voice/lead-context'
import { formatPhoneForSpeech } from '@/lib/leads/phone'
import { resolveTransferCandidates } from '@/lib/voice/transfer-routing'
import { identityForUser } from '@/lib/voice/twilio-voice'
import type { VoiceTransferRoute, VoiceTransferTarget } from '@/types/database'

const RETELL_API_KEY = process.env.RETELL_API_KEY || ''
const RETELL_AGENT_ID = 'agent_d5891af66aa9f7a83b9f96fc3a'

// ─────────────────────────────────────────────────────────────────────────────
// Org inbound policy
// ─────────────────────────────────────────────────────────────────────────────

export type InboundSettings = {
  mode: 'ai' | 'ring_agents'
  aiOnNoAnswer: boolean
  aiAfterHours: boolean
  ringSeconds: number
  voicemailGreeting: string | null
  greeting: string | null
}

const DEFAULT_SETTINGS: InboundSettings = {
  mode: 'ai',
  aiOnNoAnswer: false,
  aiAfterHours: false,
  ringSeconds: 20,
  voicemailGreeting: null,
  greeting: null,
}

/** Read the inbound policy off an organizations row (tolerant of missing columns). */
export function inboundSettingsFromOrg(org: Record<string, unknown> | null): InboundSettings {
  if (!org) return DEFAULT_SETTINGS
  return {
    mode: org.inbound_call_mode === 'ring_agents' ? 'ring_agents' : 'ai',
    aiOnNoAnswer: org.inbound_ai_on_no_answer === true,
    aiAfterHours: org.inbound_ai_after_hours === true,
    ringSeconds: Math.max(5, Math.min(60, Number(org.inbound_ring_seconds) || 20)),
    voicemailGreeting: (org.inbound_voicemail_greeting as string | null) || null,
    greeting: (org.inbound_greeting as string | null) || null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Caller context (org + lead + Retell dynamic variables)
// ─────────────────────────────────────────────────────────────────────────────

export type InboundContext = {
  orgId: string | null
  leadId: string | null
  conversationId: string | null
  practiceName: string
  voiceTimezone: string | null
  isNewLead: boolean
  settings: InboundSettings
  dynamicVariables: Record<string, string>
}

/**
 * Resolve the org (by dialed number), match or auto-create the caller's lead,
 * find/create the voice conversation, and assemble the Retell dynamic variables.
 * Never throws — on any failure it returns an unattributed context whose
 * dynamicVariables still let the AI answer generically.
 */
export async function buildInboundContext(
  supabase: SupabaseClient | null,
  params: {
    from: string
    to: string
    callerCity?: string
    callerState?: string
    callerName?: string
  }
): Promise<InboundContext> {
  const { from, to, callerCity = '', callerState = '', callerName = '' } = params

  let practiceName = 'our practice'
  let dynamicVariables: Record<string, string> = {
    call_direction: 'inbound',
    caller_phone: from,
    caller_full_name: 'the caller',
    caller_first_name: '',
    caller_last_name: '',
    caller_location: [callerCity, callerState].filter(Boolean).join(', ') || 'unknown',
    lead_status: 'unknown',
    lead_score: '0', // maps from ai_score internally
    lead_source: 'unknown',
    lead_notes: '',
    is_new_lead: 'true',
    is_returning: 'false',
    practice_name: practiceName,
    personality_type: '',
    communication_style: '',
  }
  let leadId: string | null = null
  let orgId: string | null = null
  let conversationId: string | null = null
  let voiceTimezone: string | null = null
  let isNewLead = false
  let settings: InboundSettings = DEFAULT_SETTINGS

  if (supabase) {
    try {
      // ── Get the organization ──
      // select('*') on purpose: the inbound_* policy columns may not exist yet on
      // a deployment that predates the routing migration, and a named-column
      // select would error the whole lookup (stranding attribution) instead of
      // just missing the new fields.
      const { data: org } = await supabase
        .from('organizations')
        .select('*')
        .eq('voice_outbound_caller_id', to)
        .single()

      let orgRow: Record<string, unknown> | null = org || null
      if (org) {
        orgId = org.id
        practiceName = org.name || 'our practice'
      } else {
        // Fallback only when genuinely single-tenant. Guessing "first org" in a
        // multi-tenant deployment would attribute a call (and any created lead /
        // PHI) to the wrong tenant.
        const { data: orgs } = await supabase
          .from('organizations')
          .select('*')
          .limit(2)
        if (orgs && orgs.length === 1) {
          orgRow = orgs[0]
          orgId = orgs[0].id
          practiceName = orgs[0].name || 'our practice'
          console.log(`[Voice Inbound] Single-tenant org fallback: ${orgs[0].name}`)
        } else {
          console.warn(`[Voice Inbound] No org matched caller-id ${to} and deployment is multi-tenant — not attributing call`)
        }
      }
      settings = inboundSettingsFromOrg(orgRow)

      if (orgId) {
        // Practice-timezone clock for the voice agent (see date variables below).
        const { data: bs } = await supabase
          .from('booking_settings')
          .select('timezone')
          .eq('organization_id', orgId)
          .maybeSingle()
        voiceTimezone = (bs?.timezone as string | null) ?? null
      }

      // ── Look up the caller ──
      if (orgId) {
        const normalizedPhone = from.replace(/^\+1/, '').replace(/\D/g, '')
        const phoneVariants = [
          from,
          normalizedPhone,
          `+1${normalizedPhone}`,
          `(${normalizedPhone.slice(0, 3)}) ${normalizedPhone.slice(3, 6)}-${normalizedPhone.slice(6)}`,
        ]

        // leads.phone/phone_formatted are encrypted at rest (enc::…) —
        // plaintext equality never matches and every caller would be
        // auto-created as a duplicate. Match on the deterministic phone_hash.
        const { searchHash } = await import('@/lib/encryption')
        const phoneHashes = [...new Set(phoneVariants.map(p => searchHash(p)).filter(Boolean))] as string[]

        let { data: existingLead } = await supabase
          .from('leads')
          .select('id, first_name, last_name, email, phone, status, ai_score, notes, source_type, personality_profile')
          .eq('organization_id', orgId)
          .in('phone_hash', phoneHashes)
          .limit(1)
          .maybeSingle()

        if (!existingLead) {
          // Legacy fallback: pre-encryption rows may still hold plaintext.
          const { data: plainLead } = await supabase
            .from('leads')
            .select('id, first_name, last_name, email, phone, status, ai_score, notes, source_type, personality_profile')
            .eq('organization_id', orgId)
            .or([
              ...phoneVariants.map(p => `phone.eq.${p}`),
              ...phoneVariants.map(p => `phone_formatted.eq.${p}`),
            ].join(','))
            .limit(1)
            .maybeSingle()
          existingLead = plainLead
        }

        let lead = existingLead

        if (!lead) {
          // Auto-create lead — encrypt PII the same way the CRUD routes do so
          // the row is consistent with encryption-at-rest (and future hash
          // lookups can find it).
          const { encryptLeadPII } = await import('@/lib/encryption')
          const displayName = callerName || `Caller ${normalizedPhone.slice(-4)}`
          const nameParts = displayName.split(' ')
          const { data: newLead } = await supabase
            .from('leads')
            .insert(encryptLeadPII({
              organization_id: orgId,
              first_name: nameParts[0] || 'Unknown',
              last_name: nameParts.slice(1).join(' ') || 'Caller',
              phone: from,
              phone_formatted: from,
              source_type: 'inbound_call',
              status: 'new',
              ai_score: 50,
              notes: `Auto-created from inbound call on ${new Date().toLocaleDateString()}. ${callerCity ? `Location: ${callerCity}, ${callerState}` : ''}`.trim(),
              voice_consent: true,
              voice_consent_at: new Date().toISOString(),
              voice_consent_source: 'inbound_call',
            }))
            .select()
            .single()

          if (newLead) {
            lead = newLead
            isNewLead = true
            console.log(`[Voice Inbound] Created lead: ${newLead.id}`)
          }
        } else {
          console.log(`[Voice Inbound] Found lead: ${lead.first_name} ${lead.last_name}`)
        }

        if (lead) {
          leadId = lead.id
          const personality = lead.personality_profile as Record<string, unknown> | null
          dynamicVariables = {
            call_direction: 'inbound',
            caller_phone: from,
            caller_first_name: lead.first_name || '',
            caller_last_name: lead.last_name || '',
            caller_full_name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || 'the caller',
            caller_location: [callerCity, callerState].filter(Boolean).join(', ') || 'unknown',
            lead_status: lead.status || 'unknown',
            lead_score: String(lead.ai_score || 0),
            lead_source: lead.source_type || 'unknown',
            lead_notes: (lead.notes || '').slice(0, 500),
            is_new_lead: String(isNewLead),
            is_returning: String(!isNewLead),
            practice_name: practiceName,
            personality_type: (personality?.type as string) || '',
            communication_style: (personality?.communication_style as string) || '',
          }

          // Returning caller → give the agent its memory: last conversation
          // summary, recent messages, and appointment history. New leads have
          // nothing to load. Best-effort: a failure degrades to empty strings
          // rather than delaying the TwiML response.
          if (!isNewLead) {
            try {
              Object.assign(
                dynamicVariables,
                await buildLeadContextVariables(supabase, lead.id, orgId, voiceTimezone)
              )
            } catch (ctxErr) {
              console.error('[Voice Inbound] Lead context error (non-fatal):', ctxErr)
            }
          }

          // Create/find conversation
          try {
            const { data: conv } = await supabase
              .from('conversations')
              .select('id')
              .eq('organization_id', orgId)
              .eq('lead_id', lead.id)
              .eq('channel', 'voice')
              .order('created_at', { ascending: false })
              .limit(1)
              .single()

            if (conv) {
              conversationId = conv.id
            } else {
              const { data: newConv } = await supabase
                .from('conversations')
                .insert({
                  organization_id: orgId,
                  lead_id: lead.id,
                  channel: 'voice',
                  status: 'open',
                  ai_enabled: true,
                  last_message_at: new Date().toISOString(),
                })
                .select('id')
                .single()
              conversationId = newConv?.id || null
            }
          } catch (convErr) {
            console.error('[Voice Inbound] Conversation error (non-fatal):', convErr)
          }
        }
      }
    } catch (dbError) {
      console.error('[Voice Inbound] DB error (non-fatal, proceeding):', dbError)
    }
  }

  // Ground the hosted voice agent in the real clock + a dated 2-week calendar so
  // it never says "next Tuesday" without knowing the date. The Retell prompt must
  // reference {{current_datetime}} and {{upcoming_dates}}.
  Object.assign(dynamicVariables, buildDateDynamicVariables(voiceTimezone))

  // The practice number the patient dialed (`to`) is the number they should call
  // back — expose it so the voicemail/callback prompt speaks our line, never the
  // caller's own number.
  dynamicVariables.callback_number = formatPhoneForSpeech(to)

  return { orgId, leadId, conversationId, practiceName, voiceTimezone, isNewLead, settings, dynamicVariables }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ring plan — who should ring right now, per the live-transfer routes/targets
// ─────────────────────────────────────────────────────────────────────────────

export type RingTarget = Pick<VoiceTransferTarget, 'id' | 'kind' | 'destination' | 'user_id' | 'name'>

export type InboundRingPlan = {
  /** False when at least one routing window exists and none contains `now`. */
  inHours: boolean
  /** Ordered dialable targets for the current window (empty when out of hours). */
  targets: RingTarget[]
}

/**
 * Business hours and the ring list both derive from the live-transfer config:
 * a non-overflow voice_transfer_routes window that contains `now` supplies the
 * targets to ring. An org with NO windows configured is treated as always
 * in-hours ringing every active on-duty target, so turning on ring_agents
 * without configuring routes still rings somebody instead of dead-ending.
 */
export async function resolveInboundRingPlan(
  supabase: SupabaseClient,
  orgId: string,
  now: Date = new Date()
): Promise<InboundRingPlan> {
  const [{ data: routes }, { data: targets }] = await Promise.all([
    supabase
      .from('voice_transfer_routes')
      .select('*')
      .eq('organization_id', orgId)
      .eq('active', true),
    supabase
      .from('voice_transfer_targets')
      .select('id, kind, destination, user_id, name, active, on_duty')
      .eq('organization_id', orgId)
      .eq('active', true)
      .eq('on_duty', true),
  ])

  const allTargets = (targets || []) as (RingTarget & { active: boolean; on_duty: boolean })[]
  const activeRoutes = (routes || []) as VoiceTransferRoute[]
  const windowed = activeRoutes.filter(r => !r.is_overflow)

  if (windowed.length === 0) {
    return { inHours: true, targets: allTargets }
  }

  const { primary } = resolveTransferCandidates(activeRoutes, now)
  if (primary.length === 0) return { inHours: false, targets: [] }

  const byId = new Map(allTargets.map(t => [t.id, t]))
  const ordered = primary.map(id => byId.get(id)).filter(Boolean) as RingTarget[]
  // A window whose targets were all deactivated still means "we're open" —
  // in-hours with nobody to ring falls to the org's no-answer policy.
  return { inHours: true, targets: ordered }
}

// ─────────────────────────────────────────────────────────────────────────────
// Retell registration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register the call with Retell so the SIP bridge has an agent waiting.
 * Returns the Retell call id, or null on failure (caller picks the fallback).
 */
export async function registerRetellCall(params: {
  from: string
  to: string
  twilioCallSid: string
  dynamicVariables: Record<string, string>
  metadata: Record<string, unknown>
}): Promise<string | null> {
  try {
    const retellRes = await fetch('https://api.retellai.com/v2/register-phone-call', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RETELL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: RETELL_AGENT_ID,
        from_number: params.from,
        to_number: params.to,
        direction: 'inbound',
        retell_llm_dynamic_variables: params.dynamicVariables,
        metadata: { twilio_call_sid: params.twilioCallSid, ...params.metadata },
      }),
    })
    if (!retellRes.ok) {
      console.error('[Voice Inbound] Retell register failed:', retellRes.status, await retellRes.text())
      return null
    }
    const retellData = await retellRes.json()
    return (retellData.call_id as string) || null
  } catch (e) {
    console.error('[Voice Inbound] Retell register error:', e)
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TwiML builders
// ─────────────────────────────────────────────────────────────────────────────

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function twimlResponse(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${inner}</Response>`
}

/** Bridge the caller to the registered Retell agent over SIP. */
export function retellSipTwiml(retellCallId: string): string {
  return twimlResponse(
    `\n  <Dial>\n    <Sip>sip:${xmlEscape(retellCallId)}@sip.retellai.com;transport=tcp</Sip>\n  </Dial>\n`
  )
}

/**
 * Ring the practice's live targets simultaneously: PSTN/SIP targets on their
 * numbers, softphone reps in the browser (<Client> with the staff identity —
 * the custom parameters let the widget show who's calling and log a disposition
 * against the right voice_calls row). Twilio bridges whoever answers first and
 * cancels the rest; when nobody answers within `ringSeconds`, Twilio POSTs the
 * `action` URL, which decides AI-takeover vs voicemail.
 */
export function ringAgentsTwiml(params: {
  targets: RingTarget[]
  ringSeconds: number
  actionUrl: string
  voiceCallId: string
  leadId: string | null
  leadName: string
  /** Answered-greeting played before the ring. Also defeats the forwarding
   *  carrier's no-answer pullback (e.g. GHL voicemail): a <Say> answers the
   *  parent leg, so the upstream forward is "connected" before agents ring. */
  greeting?: string | null
}): string {
  const { targets, ringSeconds, actionUrl, voiceCallId, leadId, leadName } = params
  const greeting = params.greeting?.trim()
  const legs = targets.map((t) => {
    if (t.kind === 'softphone_user' && t.user_id) {
      return [
        '    <Client>',
        `      <Identity>${xmlEscape(identityForUser(t.user_id))}</Identity>`,
        `      <Parameter name="voiceCallId" value="${xmlEscape(voiceCallId)}"/>`,
        leadId ? `      <Parameter name="leadId" value="${xmlEscape(leadId)}"/>` : '',
        `      <Parameter name="leadName" value="${xmlEscape(leadName)}"/>`,
        '    </Client>',
      ].filter(Boolean).join('\n')
    }
    if (t.kind === 'sip' && t.destination) {
      return `    <Sip>${xmlEscape(t.destination)}</Sip>`
    }
    return t.destination ? `    <Number>${xmlEscape(t.destination)}</Number>` : ''
  }).filter(Boolean).join('\n')

  // With a greeting the call is answered before the <Dial>, so answerOnBridge
  // no longer applies; without one, keep ring-tone passthrough as before.
  const say = greeting ? `  <Say voice="Polly.Joanna-Neural">${xmlEscape(greeting)}</Say>\n` : ''
  const bridge = greeting ? '' : ' answerOnBridge="true"'
  return twimlResponse(
    `\n${say}  <Dial timeout="${ringSeconds}"${bridge} action="${xmlEscape(actionUrl)}" method="POST">\n${legs}\n  </Dial>\n`
  )
}

/**
 * Take a voicemail. The <Record> action URL receives RecordingUrl when the
 * caller finishes; the transcription callback (same route, kind=transcript)
 * arrives asynchronously with the text.
 */
export function voicemailTwiml(params: {
  greeting: string | null
  practiceName: string
  actionUrl: string
  transcribeCallbackUrl: string
}): string {
  const greeting = params.greeting?.trim()
    || `Thank you for calling ${params.practiceName}. We can't take your call right now. Please leave your name, number, and a brief message after the beep, and we'll get back to you as soon as possible.`
  return twimlResponse(
    `\n  <Say>${xmlEscape(greeting)}</Say>\n  <Record maxLength="180" playBeep="true" action="${xmlEscape(params.actionUrl)}" method="POST" transcribe="true" transcribeCallback="${xmlEscape(params.transcribeCallbackUrl)}"/>\n  <Hangup/>\n`
  )
}

export function sayHangupTwiml(message: string): string {
  return twimlResponse(`\n  <Say>${xmlEscape(message)}</Say>\n  <Hangup/>\n`)
}

export function hangupTwiml(): string {
  return twimlResponse('<Hangup/>')
}
