/**
 * VENDORED MIRROR of the Dion spine `@dion/contracts` envelope. Lead Intelligence
 * is islanded (own repo/Supabase/Vercel) and cannot import the unpublished spine
 * packages, so the envelope + the event families we emit are vendored here.
 * Keep byte-faithful to the hub schema — events that pass this validator MUST pass
 * the receiver's validator at dion-clinical `/api/bus/receive`.
 *
 * Source of truth: ~/dion-clinical/lib/dion/envelope.ts
 *
 * Note: `id` (uuid) and `occurredAt` (ISO) are typed loosely as `z.string()` here
 * because WE generate them (always valid) and the receiver does the authoritative
 * strict check. The load-bearing validation on our side is structure + `data`.
 */
import { z } from 'zod'

export const DION_PRODUCTS = [
  'dion-platform',
  'patient-engagement',
  'aurea',
  'mdrcm',
  'smile-design-lab',
  'oralogix',
  'lead-intelligence',
  'dion-growth-studio',
  'dion-workforce',
  'dion-desk',
  'dion-clinical',
  'dion-scribe',
  'dion-finance',
  'dion-supply',
  'dion-pay',
] as const

export const dionProduct = z.enum(DION_PRODUCTS)
export type DionProduct = (typeof DION_PRODUCTS)[number]

export const envelopeBase = z.object({
  id: z.string(),
  envelopeVersion: z.literal(1),
  source: dionProduct,
  occurredAt: z.string(),
  dionPracticeId: z.string().min(1).nullable(),
  idempotencyKey: z.string().min(1).optional(),
  traceId: z.string().min(1).optional(),
})

export type DionEnvelope = z.infer<typeof envelopeBase>

export function dionEvent<TType extends string, TData extends z.ZodTypeAny>(
  type: TType,
  data: TData,
) {
  return envelopeBase.extend({ type: z.literal(type), data })
}

/** Publisher helper: the envelope metadata common to every event. */
export function newEnvelopeMeta(
  source: DionProduct,
  dionPracticeId: string | null,
  extras?: { id?: string; idempotencyKey?: string; traceId?: string },
): DionEnvelope {
  return {
    // A stable, caller-supplied id makes retries idempotent (the receiver dedupes
    // on envelope id); fall back to a random uuid for one-shot events.
    id: extras?.id ?? crypto.randomUUID(),
    envelopeVersion: 1,
    source,
    occurredAt: new Date().toISOString(),
    dionPracticeId,
    ...(extras?.idempotencyKey ? { idempotencyKey: extras.idempotencyKey } : {}),
    ...(extras?.traceId ? { traceId: extras.traceId } : {}),
  }
}
