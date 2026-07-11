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
import { createHash } from 'node:crypto'
import type { z } from 'zod'
import { newEnvelopeMeta } from './dion/envelope'
import { dionAppointmentSchema, type DionAppointmentEvent } from './dion/appointment'
import { dionCaseSchema, type DionCaseEvent } from './dion/case'

const SOURCE = 'lead-intelligence' as const

/**
 * Deterministic UUID (v5-style over SHA-1) from a seed. Using this as the envelope
 * id means a retry of the same logical event carries the same id, so Dion Clinical
 * (which dedupes on envelope id) records it once instead of duplicating the chart entry.
 */
function stableUuid(seed: string): string {
  const h = createHash('sha1').update(seed).digest('hex')
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export type DionEmitResult = {
  ok: boolean
  /** true when the bridge isn't configured — a no-op, not a failure. */
  skipped?: boolean
  status?: number
  error?: string
}

function getConfig(): { base: string; secret: string; bypass: string | null } | null {
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
  // dion-clinical sits behind Vercel Deployment Protection; a Protection-Bypass
  // for-Automation token lets these server-to-server calls through while the app
  // stays protected for humans. Set to VERCEL_AUTOMATION_BYPASS_SECRET from dion-clinical.
  const bypass = process.env.DION_CLINICAL_BYPASS?.trim() || null
  return { base, secret, bypass }
}

/** Headers common to every call: the shared bus secret + optional Vercel
 * protection-bypass so the request survives Deployment Protection. */
function dionHeaders(config: { secret: string; bypass: string | null }, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { 'x-forward-secret': config.secret, ...extra }
  if (config.bypass) headers['x-vercel-protection-bypass'] = config.bypass
  return headers
}

async function emitWith(event: unknown, schema: z.ZodTypeAny): Promise<DionEmitResult> {
  const config = getConfig()
  if (!config) return { ok: true, skipped: true }

  // Validate locally before sending. The receiver is authoritative, but catching
  // a malformed event here avoids a pointless round-trip + dead-letter.
  const parsed = schema.safeParse(event)
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
      headers: dionHeaders(config, { 'Content-Type': 'application/json' }),
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

function emit(event: DionAppointmentEvent): Promise<DionEmitResult> {
  return emitWith(event, dionAppointmentSchema)
}

export function emitAppointmentRequested(p: {
  appointmentId: string
  dionPatientId?: string | null
  dionPracticeId?: string | null
}): Promise<DionEmitResult> {
  return emit({
    ...newEnvelopeMeta(SOURCE, p.dionPracticeId ?? null, {
      id: stableUuid(`${p.appointmentId}:appointment.requested`),
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
      id: stableUuid(`${p.appointmentId}:appointment.booked`),
      idempotencyKey: `${p.appointmentId}:appointment.booked`,
    }),
    type: 'appointment.booked',
    data: { appointmentId: p.appointmentId, dionPatientId: p.dionPatientId ?? null, startsAt: ts.toISOString() },
  })
}

/**
 * Emit case.treatment_agreed — the patient agreed to the treatment plan (case
 * closed in the CRM). Dion Clinical opens a surgery-scheduling work item.
 */
export function emitCaseTreatmentAgreed(p: {
  caseId: string
  treatmentPlanId?: string | null
  agreementConfirmedAt: string
  estimatedSurgeryDate?: string | null
  proceduresCdt?: string[]
  dionPatientId?: string | null
  dionPracticeId?: string | null
}): Promise<DionEmitResult> {
  const confirmedAt = new Date(p.agreementConfirmedAt)
  if (Number.isNaN(confirmedAt.getTime())) {
    return Promise.resolve({ ok: false, error: `invalid agreementConfirmedAt: ${p.agreementConfirmedAt}` })
  }
  const event: DionCaseEvent = {
    ...newEnvelopeMeta(SOURCE, p.dionPracticeId ?? null, {
      id: stableUuid(`${p.caseId}:case.treatment_agreed`),
      idempotencyKey: `${p.caseId}:case.treatment_agreed`,
    }),
    type: 'case.treatment_agreed',
    data: {
      caseId: p.caseId,
      dionPatientId: p.dionPatientId ?? null,
      treatmentPlanId: p.treatmentPlanId ?? null,
      agreementConfirmedAt: confirmedAt.toISOString(),
      estimatedSurgeryDate: p.estimatedSurgeryDate ?? null,
      proceduresCdt: p.proceduresCdt ?? [],
    },
  }
  return emitWith(event, dionCaseSchema)
}

export type DionSurgeryStatusResult = {
  ok: boolean
  /** true when the bridge isn't configured or we lack a practice id — a no-op. */
  skipped?: boolean
  /** false when Dion Clinical has no work item for this case. */
  found?: boolean
  surgeryStatus?: 'open' | 'scheduled' | 'dismissed' | 'completed' | null
  surgeryDate?: string | null
  status?: number
  error?: string
}

/**
 * Read back a surgery hand-off's status from Dion Clinical — the return half of
 * emitCaseTreatmentAgreed. Dion Clinical owns the surgery; this reflects whether
 * the front desk scheduled it. GET is the loop-closer (LI has no inbound bus
 * receiver, and an echo event would need hub `@dion/contracts` coordination).
 * Never throws; a federation hiccup must not break the case view.
 */
export async function fetchCaseSurgeryStatus(p: {
  caseId: string
  dionPracticeId?: string | null
}): Promise<DionSurgeryStatusResult> {
  const config = getConfig()
  if (!config) return { ok: true, skipped: true }
  // Dion Clinical scopes the read by practice — without it we can't ask.
  if (!p.dionPracticeId) return { ok: true, skipped: true }

  try {
    const url =
      `${config.base}/api/cases/${encodeURIComponent(p.caseId)}/status` +
      `?dionPracticeId=${encodeURIComponent(p.dionPracticeId)}`
    const res = await fetch(url, {
      headers: dionHeaders(config),
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 404) return { ok: true, found: false }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, status: res.status, error: `dion-clinical ${res.status}: ${text.slice(0, 200)}` }
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return {
      ok: true,
      found: json.found === true,
      surgeryStatus: (json.surgeryStatus as DionSurgeryStatusResult['surgeryStatus']) ?? null,
      surgeryDate: (json.surgeryDate as string | null) ?? null,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'fetch failed' }
  }
}

/** A curated, PHI-bounded follow-up brief for a finished visit — the READ-arm
 * payload Dion Clinical returns from /api/encounters/:id/brief. The note gist
 * (assessment/plan) is clinical narrative and INTERNAL: never disclose it to the
 * patient. `externalCaseId` is the LI clinical_cases.id — the bridge back to a lead. */
export type DionEncounterBrief = {
  encounterId: string
  found: boolean
  dionPatientId: string | null
  externalCaseId: string | null
  externalPlanId: string | null
  encounterStatus: string | null
  completedAt: string | null
  note: {
    type: string
    status: string
    signed: boolean
    assessment: string | null
    plan: string | null
  } | null
  findings: Array<{ kind: string; severity: string }>
}

export type DionEncounterBriefResult = {
  ok: boolean
  /** true when the bridge isn't configured or we lack a practice id — a no-op. */
  skipped?: boolean
  found?: boolean
  brief?: DionEncounterBrief
  status?: number
  error?: string
}

/**
 * Pull an encounter follow-up brief from Dion Clinical — the READ half of the
 * "encounter summarized → notify → pull brief" loop. Called after LI receives a
 * clinical.scribe_completed / clinical.encounter_completed event off the bus.
 * Clinical scopes the read by practice; mirrors fetchCaseSurgeryStatus (never
 * throws — a federation hiccup must not break inbound processing).
 */
export async function fetchEncounterBrief(p: {
  encounterId: string
  dionPracticeId?: string | null
}): Promise<DionEncounterBriefResult> {
  const config = getConfig()
  if (!config) return { ok: true, skipped: true }
  if (!p.dionPracticeId) return { ok: true, skipped: true }

  try {
    const url =
      `${config.base}/api/encounters/${encodeURIComponent(p.encounterId)}/brief` +
      `?dionPracticeId=${encodeURIComponent(p.dionPracticeId)}`
    const res = await fetch(url, {
      headers: dionHeaders(config),
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 404) return { ok: true, found: false }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, status: res.status, error: `dion-clinical ${res.status}: ${text.slice(0, 200)}` }
    }
    const json = (await res.json().catch(() => ({}))) as DionEncounterBrief
    return { ok: true, found: json.found === true, brief: json }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'fetch failed' }
  }
}

export function emitAppointmentCancelled(p: {
  appointmentId: string
  reasonCode?: string
  dionPracticeId?: string | null
}): Promise<DionEmitResult> {
  return emit({
    ...newEnvelopeMeta(SOURCE, p.dionPracticeId ?? null, {
      id: stableUuid(`${p.appointmentId}:appointment.cancelled`),
      idempotencyKey: `${p.appointmentId}:appointment.cancelled`,
    }),
    type: 'appointment.cancelled',
    data: p.reasonCode
      ? { appointmentId: p.appointmentId, reasonCode: p.reasonCode }
      : { appointmentId: p.appointmentId },
  })
}
