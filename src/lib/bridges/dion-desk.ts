/**
 * Bridge to Dion Desk (the omnichannel contact center sibling app).
 *
 * Existing-patient inbound calls are Dion Desk's workflow, not the LI sales
 * funnel (ecosystem matrix). Desk is NOT yet provisioned to receive (demo-only,
 * no Dion Health SF tenant), so this bridge is DURABLE: ingestion enqueues into
 * public.dion_desk_outbox; `forwardDeskOutbox` (a cron) drains it to Desk's bus
 * receiver once DION_DESK_URL + DION_BUS_SECRET are set. Until then rows sit
 * 'pending' — buffered, never lost, never blocking ingestion.
 *
 * Env (Vercel, server-only):
 *   DION_DESK_URL   — e.g. https://dion-desk-xxxx.vercel.app  (unset ⇒ no-op forwarder)
 *   DION_BUS_SECRET — shared secret; MUST equal Dion Desk's receiver secret
 */
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { newEnvelopeMeta } from './dion/envelope'
import { dionDeskContactSchema, type DionDeskContactEvent } from './dion/desk'

const SOURCE = 'lead-intelligence' as const
const EVENT_TYPE = 'comms.contact_identified' as const

/** Deterministic UUID (v5-style over SHA-1) — a retry of the same logical event
 *  carries the same envelope id, so Desk dedupes it. */
function stableUuid(seed: string): string {
  const h = createHash('sha1').update(seed).digest('hex')
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export type EnqueueDeskContactInput = {
  organizationId: string
  leadId: string
  patientId: string
  matchMethod: 'email_hash' | 'phone_hash'
  sourceType: string | null
  /**
   * How the patient reached us. Defaults to 'inbound_call' — this path was
   * call-tracking-only until the check moved into the shared ingest helper,
   * where a form fill or a social DM is just as likely as a call.
   */
  channel?: 'inbound_call' | 'form' | 'social_dm' | 'inbound_message'
}

/**
 * Enqueue an existing-patient inbound contact for hand-off to Dion Desk.
 * Idempotent on (leadId, event) so a re-ingest of the same lead enqueues once.
 * Best-effort — callers wrap in try/catch; a failure never affects ingestion.
 */
export async function enqueueDeskExistingPatientContact(
  supabase: SupabaseClient,
  input: EnqueueDeskContactInput,
): Promise<void> {
  const idempotencyKey = `${input.leadId}:${EVENT_TYPE}`
  await supabase
    .from('dion_desk_outbox')
    .upsert(
      {
        organization_id: input.organizationId,
        lead_id: input.leadId,
        patient_id: input.patientId,
        event_type: EVENT_TYPE,
        idempotency_key: idempotencyKey,
        payload: {
          matchMethod: input.matchMethod,
          channel: input.channel ?? 'inbound_call',
          sourceType: input.sourceType,
        },
      },
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    )
}

/** Voice transcripts ride the same outbox but land on Desk's voice ingest route. */
const VOICE_EVENT_TYPE = 'comms.voice_transcript' as const

export type EnqueueDeskVoiceInput = {
  organizationId: string
  /** voice_calls.id — the idempotency anchor. */
  callId: string
  leadId: string | null
  /** Patient phone: the caller on inbound, the callee on outbound. */
  patientNumber: string | null
  /** The dialed Dion/practice number — Desk routes to an account by this. */
  practiceNumber: string | null
  transcript: string | null
  direction: 'inbound' | 'outbound'
  twilioCallSid?: string | null
}

/**
 * Enqueue a finalized call transcript for hand-off to Dion Desk, which owns
 * ticketing/SLA/escalation (ECOSYSTEM.md). Buffered in dion_desk_outbox exactly
 * like the contact events, so a Desk outage delays the ticket instead of losing
 * the call — and so every finalization path (the Retell webhook AND the reconcile
 * sweep) can enqueue the same call without opening two tickets.
 *
 * Skips silently when there is nothing Desk can act on: no transcript to triage,
 * no caller to key a contact by, or no dialed number for it to route on (Desk
 * fails closed with 422 rather than filing PHI into a shared account).
 *
 * Best-effort — never throws into the post-call path.
 */
export async function enqueueDeskVoiceTranscript(
  supabase: SupabaseClient,
  input: EnqueueDeskVoiceInput,
): Promise<void> {
  const transcript = (input.transcript || '').trim()
  if (!transcript || !input.patientNumber || !input.practiceNumber) return

  await supabase.from('dion_desk_outbox').upsert(
    {
      organization_id: input.organizationId,
      lead_id: input.leadId,
      event_type: VOICE_EVENT_TYPE,
      idempotency_key: `${input.callId}:${VOICE_EVENT_TYPE}`,
      payload: {
        from: input.patientNumber,
        calledNumber: input.practiceNumber,
        transcript,
        direction: input.direction,
        callSid: input.twilioCallSid ?? null,
      },
    },
    { onConflict: 'idempotency_key', ignoreDuplicates: true },
  )
}

function getConfig(): { base: string; secret: string } | null {
  const base = process.env.DION_DESK_URL?.replace(/\/$/, '')
  const secret = process.env.DION_BUS_SECRET
  if (!base || !secret) return null
  try {
    const u = new URL(base)
    const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocal)) return null
  } catch {
    return null
  }
  return { base, secret }
}

const MAX_ATTEMPTS = 8

type OutboxRow = {
  id: string
  organization_id: string
  lead_id: string | null
  patient_id: string | null
  attempts: number
  idempotency_key: string
  event_type: string
  payload: {
    matchMethod?: string
    sourceType?: string | null
    // comms.voice_transcript
    from?: string
    calledNumber?: string
    transcript?: string
    direction?: string
    callSid?: string | null
  } | null
}

/** One outbound HTTP attempt: where it goes, how it authenticates, what it sends. */
type Delivery = { path: string; headers: Record<string, string>; body: string }

/**
 * Desk exposes two doors with two different secrets: the contracts bus
 * (/api/bus/receive, x-forward-secret = DION_BUS_SECRET) and the voice ingest
 * route (/api/ingest/voice, x-relay-token = Desk's RELAY_SECRET). Voice uses the
 * latter so no change is required on the Desk side — it already speaks this shape.
 *
 * DELIBERATELY OMITTED from the voice body: durationSeconds / model / usage. Desk's
 * ingest route meters those into ITS ledger as Twilio minutes and Anthropic tokens.
 * Ours are Retell's and already metered on the LI side, so forwarding them would
 * double-bill and contaminate Desk's spend rollup. Send the content, not the meter.
 */
function buildVoiceDelivery(row: OutboxRow): Delivery | { error: string } {
  const secret = process.env.DION_DESK_RELAY_SECRET
  if (!secret) return { error: 'DION_DESK_RELAY_SECRET not configured' }
  const p = row.payload ?? {}
  if (!p.transcript || !p.from || !p.calledNumber) {
    return { error: 'voice payload missing transcript/from/calledNumber' }
  }
  return {
    path: '/api/ingest/voice',
    headers: { 'Content-Type': 'application/json', 'x-relay-token': secret },
    body: JSON.stringify({
      from: p.from,
      calledNumber: p.calledNumber,
      transcript: p.transcript,
      direction: p.direction === 'outbound' ? 'outbound' : 'inbound',
      callSid: p.callSid ?? undefined,
    }),
  }
}

export type ForwardResult = {
  skipped?: boolean
  scanned: number
  sent: number
  failed: number
}

type DeliveryOutcome = { ok: boolean; error?: string }

/** One HTTP attempt against Desk. Never throws — transport errors become outcomes. */
async function deliver(base: string, d: Delivery): Promise<DeliveryOutcome> {
  try {
    const res = await fetch(`${base}${d.path}`, {
      method: 'POST',
      headers: d.headers,
      body: d.body,
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) return { ok: true }
    const text = await res.text().catch(() => '')
    return { ok: false, error: `desk ${res.status}: ${text.slice(0, 200)}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'fetch failed' }
  }
}

/** Persist the result of one attempt, retiring the row after MAX_ATTEMPTS. */
async function recordAttempt(
  supabase: SupabaseClient,
  row: OutboxRow,
  outcome: DeliveryOutcome,
): Promise<void> {
  const attempts = row.attempts + 1
  await supabase
    .from('dion_desk_outbox')
    .update(
      outcome.ok
        ? { status: 'sent', attempts, sent_at: new Date().toISOString(), last_error: null }
        : {
            status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
            attempts,
            last_error: outcome.error ?? 'unknown error',
          },
    )
    .eq('id', row.id)
}

/**
 * Drain pending outbox rows to Dion Desk's bus receiver. No-op (skipped) until
 * DION_DESK_URL + DION_BUS_SECRET are configured, so it is safe to schedule now
 * while Desk is still being provisioned. Never throws.
 */
export async function forwardDeskOutbox(
  supabase: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<ForwardResult> {
  const config = getConfig()
  if (!config) return { skipped: true, scanned: 0, sent: 0, failed: 0 }

  const limit = opts.limit ?? 100
  const { data: rows } = await supabase
    .from('dion_desk_outbox')
    .select('id, organization_id, lead_id, patient_id, attempts, idempotency_key, event_type, payload')
    .neq('status', 'sent')
    .lt('attempts', MAX_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(limit)

  const pending = (rows ?? []) as OutboxRow[]
  let sent = 0
  let failed = 0

  for (const row of pending) {
    // ── Voice transcripts: a different Desk route + secret, no contracts envelope ──
    if (row.event_type === VOICE_EVENT_TYPE) {
      const built = buildVoiceDelivery(row)
      if ('error' in built) {
        failed += 1
        const attempts = row.attempts + 1
        await supabase
          .from('dion_desk_outbox')
          .update({
            // A missing secret is operator config, not a bad row — keep it pending
            // so it drains once the env is set instead of burning its retries.
            status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
            attempts,
            last_error: built.error,
          })
          .eq('id', row.id)
        continue
      }
      const outcome = await deliver(config.base, built)
      await recordAttempt(supabase, row, outcome)
      if (outcome.ok) sent += 1
      else failed += 1
      continue
    }

    const matchMethod = row.payload?.matchMethod === 'phone_hash' ? 'phone_hash' : 'email_hash'
    const event: DionDeskContactEvent = {
      ...newEnvelopeMeta(SOURCE, null, {
        id: stableUuid(row.idempotency_key),
        idempotencyKey: row.idempotency_key,
      }),
      type: EVENT_TYPE,
      data: {
        organizationId: row.organization_id,
        leadId: row.lead_id ?? '',
        liPatientId: row.patient_id ?? null,
        matchMethod,
        channel: 'inbound_call',
        sourceType: row.payload?.sourceType ?? null,
      },
    }

    const parsed = dionDeskContactSchema.safeParse(event)
    if (!parsed.success) {
      failed += 1
      await supabase
        .from('dion_desk_outbox')
        .update({
          status: 'failed',
          attempts: row.attempts + 1,
          last_error:
            'invalid event: ' +
            parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
        })
        .eq('id', row.id)
      continue
    }

    const outcome = await deliver(config.base, {
      path: '/api/bus/receive',
      headers: { 'Content-Type': 'application/json', 'x-forward-secret': config.secret },
      body: JSON.stringify(event),
    })
    await recordAttempt(supabase, row, outcome)
    if (outcome.ok) sent += 1
    else failed += 1
  }

  return { scanned: pending.length, sent, failed }
}
