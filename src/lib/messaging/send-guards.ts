/**
 * Mass-send guardrails — idempotency + per-org daily quota.
 *
 * Used by /api/sms/mass and /api/email/mass to prevent two failure modes:
 *   1. A retried POST re-sending the entire batch (real money + duplicate messages).
 *   2. A runaway / compromised caller blasting unbounded volume in a day.
 *
 * Idempotency is atomic: claimIdempotencyKey() INSERTs first and relies on the
 * (organization_id, idempotency_key) primary key to reject duplicate retries.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export const DAILY_SMS_CAP = Number(process.env.MASS_SMS_DAILY_CAP ?? 2000)
export const DAILY_EMAIL_CAP = Number(process.env.MASS_EMAIL_DAILY_CAP ?? 10000)

type ClaimResult =
  | { claimed: true }
  | { claimed: false; response: unknown | null }

/**
 * Atomically claim an idempotency key for this org. Returns { claimed: true }
 * the first time. On a duplicate (the key already exists), returns
 * { claimed: false, response } with the previously stored response if available.
 */
export async function claimIdempotencyKey(
  supabase: SupabaseClient,
  organizationId: string,
  key: string,
  route: string,
): Promise<ClaimResult> {
  const { error } = await supabase
    .from('mass_send_idempotency')
    .insert({ organization_id: organizationId, idempotency_key: key, route })

  if (!error) return { claimed: true }

  // Insert failed — almost certainly a unique-violation (duplicate key).
  // Return whatever response the original request recorded, if any.
  const { data } = await supabase
    .from('mass_send_idempotency')
    .select('response')
    .eq('organization_id', organizationId)
    .eq('idempotency_key', key)
    .maybeSingle()

  return { claimed: false, response: data?.response ?? null }
}

/** Persist the final response against a previously-claimed idempotency key. */
export async function recordIdempotencyResponse(
  supabase: SupabaseClient,
  organizationId: string,
  key: string,
  response: unknown,
): Promise<void> {
  await supabase
    .from('mass_send_idempotency')
    .update({ response })
    .eq('organization_id', organizationId)
    .eq('idempotency_key', key)
}

/** Count today's (since local midnight) outbound messages on a channel for the org. */
export async function countTodaysOutbound(
  supabase: SupabaseClient,
  organizationId: string,
  channel: 'sms' | 'email',
): Promise<number> {
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)

  const { count } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('channel', channel)
    .eq('direction', 'outbound')
    .gte('created_at', startOfDay.toISOString())

  return count ?? 0
}
