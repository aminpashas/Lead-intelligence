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
          channel: 'inbound_call',
          sourceType: input.sourceType,
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
  payload: { matchMethod?: string; sourceType?: string | null } | null
}

export type ForwardResult = {
  skipped?: boolean
  scanned: number
  sent: number
  failed: number
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
    .select('id, organization_id, lead_id, patient_id, attempts, idempotency_key, payload')
    .neq('status', 'sent')
    .lt('attempts', MAX_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(limit)

  const pending = (rows ?? []) as OutboxRow[]
  let sent = 0
  let failed = 0

  for (const row of pending) {
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

    let ok = false
    let errMsg: string | null = null
    let statusCode: number | null = null
    try {
      const res = await fetch(`${config.base}/api/bus/receive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forward-secret': config.secret },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(10_000),
      })
      statusCode = res.status
      ok = res.ok
      if (!ok) {
        const text = await res.text().catch(() => '')
        errMsg = `desk ${res.status}: ${text.slice(0, 200)}`
      }
    } catch (err) {
      errMsg = err instanceof Error ? err.message : 'fetch failed'
    }

    if (ok) {
      sent += 1
      await supabase
        .from('dion_desk_outbox')
        .update({ status: 'sent', attempts: row.attempts + 1, sent_at: new Date().toISOString(), last_error: null })
        .eq('id', row.id)
    } else {
      failed += 1
      const attempts = row.attempts + 1
      await supabase
        .from('dion_desk_outbox')
        .update({
          status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
          attempts,
          last_error: errMsg ?? (statusCode ? `status ${statusCode}` : 'unknown error'),
        })
        .eq('id', row.id)
    }
  }

  return { scanned: pending.length, sent, failed }
}
