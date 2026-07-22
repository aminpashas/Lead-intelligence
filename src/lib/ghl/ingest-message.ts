/**
 * Persist a normalized GHL message into LI's conversation store — the single
 * write path shared by the go-forward webhook and the historical backfill.
 *
 * Responsibilities:
 *   • find-or-create the (lead, channel) conversation
 *   • idempotently insert the message (dedup on the namespaced external_id)
 *   • log calls/voicemails as activities (the conversations.channel CHECK has no
 *     'call' value, and GHL call records rarely carry a transcript)
 *   • fold TCPA opt-out / opt-in keywords into the lead's consent state
 *
 * Counter behavior is NOT caller-controlled: the on_message_insert trigger bumps
 * unread/message counts and lead recency off every messages insert, webhook and
 * backfill alike. It stamps new.created_at (not now()), so replayed history
 * lands with its true timestamps; backfill callers still run the authoritative
 * recompute (recompute_*_stats) at the end to settle unread. Messages MUST be
 * fed in chronological order so opt-out/opt-in settles last-wins.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  isOptInMessage,
  isOptOutMessage,
  shouldRefreshCallActivity,
  type NormalizedGhlMessage,
} from './conversations'
import { advanceStageOnInboundReply } from '@/lib/pipeline/advance-on-reply'

export type IngestLead = {
  id: string
  first_name?: string | null
  last_name?: string | null
}

export type PersistResult = {
  status: 'inserted' | 'skipped' | 'call_logged'
  conversationId?: string
  /** True when this message flipped the lead's SMS consent (opt-out/opt-in). */
  consentChanged?: boolean
}

export type PersistParams = {
  organizationId: string
  lead: IngestLead
  normalized: NormalizedGhlMessage
  /** Optional (leadId:channel)→conversationId cache to avoid re-querying in bulk. */
  conversationCache?: Map<string, string>
}

/** Channels that persist as a conversation thread (everything except call/voicemail). */
export type ConversationalChannel = 'sms' | 'email' | 'web_chat' | 'whatsapp' | 'messenger' | 'instagram'

const CONVERSATIONAL_CHANNELS: readonly ConversationalChannel[] = [
  'sms',
  'email',
  'web_chat',
  'whatsapp',
  'messenger',
  'instagram',
]

/** A message insert with no persistable conversation channel (call/voicemail). */
function isConversational(n: NormalizedGhlMessage): boolean {
  return CONVERSATIONAL_CHANNELS.includes(n.channel as ConversationalChannel)
}

/** Seconds → "m:ss" (e.g. 8 → "0:08", 252 → "4:12"). */
function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

const CALL_STATE_LABEL: Record<string, string> = {
  answered: 'answered',
  voicemail: 'voicemail',
  no_answer: 'no answer',
  busy: 'busy',
  failed: 'failed',
}

/**
 * Human, outcome-aware call title for the activity feed / pre-call timeline —
 * e.g. "Outbound call · voicemail · 0:08 (GoHighLevel)". State/duration are
 * omitted when GHL didn't provide them, so it degrades to the old label. Pure.
 */
export function formatCallTitle(n: NormalizedGhlMessage): string {
  const dir = n.direction === 'outbound' ? 'Outbound' : 'Inbound'
  const parts = [`${dir} call`]
  const label = n.call ? CALL_STATE_LABEL[n.call.state] : undefined
  if (label) parts.push(label)
  if (n.call?.durationSec) parts.push(formatDuration(n.call.durationSec))
  return `${parts.join(' · ')} (GoHighLevel)`
}

/** Find-or-create the active conversation for a lead on a channel. */
async function resolveConversation(
  supabase: SupabaseClient,
  organizationId: string,
  leadId: string,
  channel: ConversationalChannel,
  cache?: Map<string, string>,
): Promise<string | null> {
  const key = `${leadId}:${channel}`
  const cached = cache?.get(key)
  if (cached) return cached

  const { data: existing } = await supabase
    .from('conversations')
    .select('id')
    .eq('lead_id', leadId)
    .eq('channel', channel)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  let id = existing?.id as string | undefined
  if (!id) {
    const { data: created } = await supabase
      .from('conversations')
      .insert({
        organization_id: organizationId,
        lead_id: leadId,
        channel,
        status: 'active',
        // Backfilled/synced GHL threads default to assist, not auto: importing
        // history must never trigger the AI to fire off a reply on its own.
        ai_enabled: false,
        ai_mode: 'assist',
        metadata: { source: 'ghl' },
      })
      .select('id')
      .single()
    id = created?.id as string | undefined
  }
  if (id) cache?.set(key, id)
  return id ?? null
}

/** Apply a TCPA opt-out/opt-in keyword to the lead's consent columns. */
async function applyConsentKeyword(
  supabase: SupabaseClient,
  organizationId: string,
  leadId: string,
  createdAt: string,
  optOut: boolean,
): Promise<void> {
  if (optOut) {
    await supabase
      .from('leads')
      .update({
        sms_consent_status: 'declined',
        sms_opt_out: true,
        sms_opt_out_at: createdAt,
        sms_consent_source: 'ghl_message',
      })
      .eq('id', leadId)
    await supabase
      .from('campaign_enrollments')
      .update({ status: 'exited', completed_at: createdAt })
      .eq('lead_id', leadId)
      .eq('status', 'active')
  } else {
    await supabase
      .from('leads')
      .update({
        sms_consent_status: 'granted',
        sms_opt_out: false,
        sms_consent: true,
        sms_consent_at: createdAt,
        sms_consent_source: 'ghl_message',
      })
      .eq('id', leadId)
  }
}

export async function persistGhlMessage(
  supabase: SupabaseClient,
  params: PersistParams,
): Promise<PersistResult> {
  const { organizationId, lead, normalized: n, conversationCache } = params

  // ── Idempotency: never insert the same GHL message twice ──
  const { data: dupe } = await supabase
    .from('messages')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('external_id', n.externalId)
    .limit(1)
    .maybeSingle()
  if (dupe) return { status: 'skipped' }

  // ── Calls/voicemails → activity, not a conversation message ──
  if (n.isCall) {
    const ghlId = n.externalId.replace(/^ghl_msg:/, '')
    const { data: existingActivity } = await supabase
      .from('lead_activities')
      .select('id, metadata')
      .eq('lead_id', lead.id)
      .eq('activity_type', 'call_logged')
      .filter('metadata->>ghl_message_id', 'eq', ghlId)
      .limit(1)
      .maybeSingle()

    const incoming = {
      state: n.call?.state ?? ('unknown' as const),
      durationSec: n.call?.durationSec ?? null,
    }

    // Already logged: refresh it only while it's still provisional (the poller
    // usually catches a call at ring time, before GHL knows the outcome). Without
    // this, the first snapshot is frozen and a connected call reads as "ringing".
    if (existingActivity) {
      const meta = (existingActivity.metadata ?? {}) as Record<string, unknown>
      if (!shouldRefreshCallActivity(meta, incoming)) return { status: 'skipped' }
      await supabase
        .from('lead_activities')
        .update({
          title: formatCallTitle(n),
          description: n.body || null,
          metadata: {
            ...meta,
            call_state: incoming.state,
            duration_seconds: incoming.durationSec,
            recording_url: n.call?.recordingUrl ?? null,
            raw_call: n.call?.raw ?? null,
            refreshed_at: new Date().toISOString(),
          },
        })
        .eq('id', existingActivity.id)
      return { status: 'call_logged' }
    }

    await supabase.from('lead_activities').insert({
      organization_id: organizationId,
      lead_id: lead.id,
      activity_type: 'call_logged',
      title: formatCallTitle(n),
      description: n.body || null,
      created_at: n.createdAt,
      metadata: {
        source: 'ghl',
        ghl_message_id: ghlId,
        direction: n.direction,
        // Enriched call detail (null when GHL omitted it) — powers the pre-call
        // timeline and gates Tier-2 summary generation (answered + long only).
        call_state: n.call?.state ?? 'unknown',
        duration_seconds: n.call?.durationSec ?? null,
        recording_url: n.call?.recordingUrl ?? null,
        raw_call: n.call?.raw ?? null,
      },
    })
    return { status: 'call_logged' }
  }

  if (!isConversational(n)) return { status: 'skipped' }
  const channel = n.channel as ConversationalChannel

  const conversationId = await resolveConversation(
    supabase,
    organizationId,
    lead.id,
    channel,
    conversationCache,
  )
  if (!conversationId) return { status: 'skipped' }

  const senderName =
    n.direction === 'inbound'
      ? `${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim() || null
      : null

  await supabase.from('messages').insert({
    organization_id: organizationId,
    conversation_id: conversationId,
    lead_id: lead.id,
    direction: n.direction,
    channel,
    body: n.body,
    subject: n.subject,
    // Inbound = the lead; outbound came from GHL (its automation or a GHL user),
    // not LI staff/AI, so 'system' is the honest attribution for imported sends.
    sender_type: n.direction === 'inbound' ? 'lead' : 'system',
    sender_name: senderName,
    status: 'delivered',
    external_id: n.externalId,
    created_at: n.createdAt,
    attachments: n.attachments,
    // `ghl_message_type` is the raw discriminator (TYPE_FACEBOOK vs
    // TYPE_INSTAGRAM). The mapped channel loses that distinction for anything
    // that collapses, and it's the only way to audit a misclassification.
    metadata: { source: 'ghl', ghl_message_type: n.sourceType },
  })

  // ── Compliance: opt-out/opt-in only meaningful on inbound SMS ──
  let consentChanged = false
  if (channel === 'sms' && n.direction === 'inbound') {
    if (isOptOutMessage(n.body)) {
      await applyConsentKeyword(supabase, organizationId, lead.id, n.createdAt, true)
      consentChanged = true
    } else if (isOptInMessage(n.body)) {
      await applyConsentKeyword(supabase, organizationId, lead.id, n.createdAt, false)
      consentChanged = true
    }
  }

  // A real inbound reply must lift the lead out of the un-worked queue ("No
  // Communication" / "New Lead") into Engaged so the status pill and board stop
  // reading "never heard from them" while the reply sits in the thread. Skip
  // consent keywords (STOP/START) — those are opt-out/opt-in, not engagement.
  if (n.direction === 'inbound' && !consentChanged) {
    await advanceStageOnInboundReply(supabase, {
      leadId: lead.id,
      organizationId,
      channel,
    })
  }

  return { status: 'inserted', conversationId, consentChanged }
}
