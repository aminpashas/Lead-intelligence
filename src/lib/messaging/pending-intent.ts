/**
 * Pending SMS reply intent
 *
 * The disambiguation primitive for two-way SMS. Multiple outbound flows solicit a
 * bare "YES" (appointment reminders, the financing denial follow-up, mass blasts).
 * Without knowing which flow last asked, the inbound webhook can't tell what a
 * "YES" answers — historically it always assumed "confirm my appointment," so a
 * YES meant for the financing follow-up confirmed the next appointment instead.
 *
 * Contract:
 *  - A soliciting send calls {@link setPendingReplyIntent} the moment it goes out.
 *  - The inbound webhook calls {@link consumePendingReplyIntent} on any affirmative
 *    reply and routes based on `intent`. Consuming clears the marker so a later,
 *    unrelated "YES" doesn't re-fire the same workflow.
 *
 * One live intent per (lead, channel): a newer solicitation overwrites the older
 * one, because the most recent question is the one the lead is answering.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type PendingReplyIntentKind =
  | 'appointment_confirm'
  | 'financing_followup'
  | 'mass_sms'

export type PendingReplyRefType = 'appointment' | 'financing_application' | 'campaign'

export type PendingReplyIntent = {
  intent: PendingReplyIntentKind
  ref_type: PendingReplyRefType | null
  ref_id: string | null
}

const TABLE = 'pending_sms_reply_intents'
const DEFAULT_TTL_HOURS = 72

/**
 * Record that an outbound SMS just asked this lead for a reply. Call it right
 * after the send succeeds. Upserts on (lead_id, channel) so the freshest
 * solicitation wins. Fire-and-forget safe — failures are swallowed and logged by
 * the caller's surrounding try/catch; a missed stamp only degrades to the old
 * "fall through to the AI responder" behavior, never a wrong workflow.
 */
export async function setPendingReplyIntent(
  supabase: SupabaseClient,
  params: {
    organizationId: string
    leadId: string
    intent: PendingReplyIntentKind
    refType?: PendingReplyRefType
    refId?: string
    channel?: 'sms'
    ttlHours?: number
  }
): Promise<void> {
  const channel = params.channel ?? 'sms'
  const ttlMs = (params.ttlHours ?? DEFAULT_TTL_HOURS) * 60 * 60 * 1000
  const expiresAt = new Date(Date.now() + ttlMs).toISOString()

  await supabase
    .from(TABLE)
    .upsert(
      {
        organization_id: params.organizationId,
        lead_id: params.leadId,
        channel,
        intent: params.intent,
        ref_type: params.refType ?? null,
        ref_id: params.refId ?? null,
        created_at: new Date().toISOString(),
        expires_at: expiresAt,
      },
      { onConflict: 'lead_id,channel' }
    )
}

/**
 * Read and clear the live intent for a lead's inbound reply. Returns null when
 * nothing is pending or the last solicitation has expired — in which case the
 * caller should let the message fall through to the AI responder rather than
 * firing any keyword workflow.
 */
export async function consumePendingReplyIntent(
  supabase: SupabaseClient,
  leadId: string,
  channel: 'sms' = 'sms'
): Promise<PendingReplyIntent | null> {
  const { data } = await supabase
    .from(TABLE)
    .select('id, intent, ref_type, ref_id, expires_at')
    .eq('lead_id', leadId)
    .eq('channel', channel)
    .gt('expires_at', new Date().toISOString())
    .limit(1)
    .maybeSingle()

  if (!data) return null

  // Consume it: this reply resolves the question, so the marker must not linger and
  // capture a later, unrelated affirmative.
  await supabase.from(TABLE).delete().eq('id', data.id)

  return {
    intent: data.intent as PendingReplyIntentKind,
    ref_type: (data.ref_type as PendingReplyRefType | null) ?? null,
    ref_id: (data.ref_id as string | null) ?? null,
  }
}

/** Clear any live intent without reading it (e.g. lead opted out). Best-effort. */
export async function clearPendingReplyIntent(
  supabase: SupabaseClient,
  leadId: string,
  channel: 'sms' = 'sms'
): Promise<void> {
  await supabase.from(TABLE).delete().eq('lead_id', leadId).eq('channel', channel)
}
