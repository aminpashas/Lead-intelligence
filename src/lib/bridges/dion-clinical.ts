/**
 * Bridge to Dion Clinical (the in-house EMR sibling app).
 *
 * Dion Clinical does not own scheduling — it *consumes* appointment.* events off
 * the Dion bus to anchor the chairside chart + recall. Lead Intelligence acts as
 * "Patient Engagement" and emits those events. We go point-to-point: POST the
 * validated envelope straight to Dion Clinical's bus receiver with the shared
 * `x-forward-secret` (the receiver accepts a direct authenticated POST).
 *
 * Mirror of the growth-studio bridge: reads config from env, times out, and
 * NEVER throws — a federation hiccup must not break a booking. Returns a result
 * so the caller (the Phase 3 sync seam) can record per-leg status.
 *
 * Env (Vercel, server-only):
 *   DION_CLINICAL_URL — e.g. https://dion-clinical-xxxx.vercel.app
 *   DION_BUS_SECRET   — shared secret; MUST equal Dion Clinical's DION_BUS_SECRET
 */
import { newEnvelopeMeta } from './dion/envelope'
import { dionAppointmentSchema, type DionAppointmentEvent } from './dion/appointment'

const SOURCE = 'lead-intelligence' as const

export type DionEmitResult = {
  ok: boolean
  /** true when the bridge isn't configured — a no-op, not a failure. */
  skipped?: boolean
  status?: number
  error?: string
}

function getConfig(): { base: string; secret: string } | null {
  const base = process.env.DION_CLINICAL_URL?.replace(/\/$/, '')
  const secret = process.env.DION_BUS_SECRET
  if (!base || !secret) return null
  // Trusted operator config (not user input) — a light guard is proportionate:
  // require https, or http only for localhost during dev.
  try {
    const u = new URL(base)
    const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocal)) return null
  } catch {
    return null
  }
  return { base, secret }
}

async function emit(event: DionAppointmentEvent): Promise<DionEmitResult> {
  const config = getConfig()
  if (!config) return { ok: true, skipped: true }

  // Validate locally before sending. The receiver is authoritative, but catching
  // a malformed event here avoids a pointless round-trip + dead-letter.
  const parsed = dionAppointmentSchema.safeParse(event)
  if (!parsed.success) {
    return {
      ok: false,
      error:
        'invalid dion event: ' +
        parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    }
  }

  try {
    const res = await fetch(`${config.base}/api/bus/receive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forward-secret': config.secret },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, status: res.status, error: `dion-clinical ${res.status}: ${text.slice(0, 200)}` }
    }
    return { ok: true, status: res.status }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'fetch failed' }
  }
}

export function emitAppointmentRequested(p: {
  appointmentId: string
  dionPatientId?: string | null
  dionPracticeId?: string | null
}): Promise<DionEmitResult> {
  return emit({
    ...newEnvelopeMeta(SOURCE, p.dionPracticeId ?? null, {
      idempotencyKey: `${p.appointmentId}:appointment.requested`,
    }),
    type: 'appointment.requested',
    data: { appointmentId: p.appointmentId, dionPatientId: p.dionPatientId ?? null },
  })
}

export function emitAppointmentBooked(p: {
  appointmentId: string
  startsAt: string
  dionPatientId?: string | null
  dionPracticeId?: string | null
}): Promise<DionEmitResult> {
  const ts = new Date(p.startsAt)
  if (Number.isNaN(ts.getTime())) {
    return Promise.resolve({ ok: false, error: `invalid startsAt: ${p.startsAt}` })
  }
  return emit({
    ...newEnvelopeMeta(SOURCE, p.dionPracticeId ?? null, {
      idempotencyKey: `${p.appointmentId}:appointment.booked`,
    }),
    type: 'appointment.booked',
    data: { appointmentId: p.appointmentId, dionPatientId: p.dionPatientId ?? null, startsAt: ts.toISOString() },
  })
}

export function emitAppointmentCancelled(p: {
  appointmentId: string
  reasonCode?: string
  dionPracticeId?: string | null
}): Promise<DionEmitResult> {
  return emit({
    ...newEnvelopeMeta(SOURCE, p.dionPracticeId ?? null, {
      idempotencyKey: `${p.appointmentId}:appointment.cancelled`,
    }),
    type: 'appointment.cancelled',
    data: p.reasonCode
      ? { appointmentId: p.appointmentId, reasonCode: p.reasonCode }
      : { appointmentId: p.appointmentId },
  })
}
