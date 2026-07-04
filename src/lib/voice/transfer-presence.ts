/**
 * Transfer Presence — rep availability read/claim/release (DB-touching).
 *
 * Availability is tracked server-side: when the broker seats a call on a rep we
 * flip them to on_call in the SAME statement that selects them (via the
 * claim_available_transfer_target RPC's FOR UPDATE SKIP LOCKED), so two answered
 * calls can never race onto one human. Release happens when the call ends.
 *
 * `resolveTargetDestination` turns a target into a dialable number: phone/sip use
 * their `destination`; a softphone_user target falls back to that staff member's
 * profile phone (Retell transfers over PSTN, so a browser Device isn't a valid
 * warm-transfer destination in this path).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { VoiceTransferRoute, VoiceTransferTarget } from '@/types/database'
import { logger } from '@/lib/logger'

/** Load the org's active routing rules (broker + dispatcher both need these). */
export async function loadActiveRoutes(
  supabase: SupabaseClient,
  organizationId: string
): Promise<VoiceTransferRoute[]> {
  const { data } = await supabase
    .from('voice_transfer_routes')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('active', true)
  return (data as VoiceTransferRoute[]) || []
}

/**
 * Ensure every active target for an org has a presence row. Idempotent — safe to
 * call each dispatcher tick and whenever a target is created. New rows start
 * 'available'; existing rows are left untouched.
 */
export async function ensurePresenceForOrg(
  supabase: SupabaseClient,
  organizationId: string
): Promise<void> {
  const { data: targets } = await supabase
    .from('voice_transfer_targets')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('active', true)

  if (!targets || targets.length === 0) return

  const rows = targets.map(t => ({
    organization_id: organizationId,
    target_id: t.id,
    status: 'available' as const,
  }))

  // onConflict target_id → do nothing (don't clobber a live on_call rep).
  const { error } = await supabase
    .from('voice_agent_presence')
    .upsert(rows, { onConflict: 'target_id', ignoreDuplicates: true })
  if (error) logger.warn('ensurePresenceForOrg upsert failed', { organizationId, error: error.message })
}

/**
 * How many of the given candidate targets are free right now. Used by the
 * dispatcher to size each dial batch (never dial more than we can hand off).
 */
export async function countAvailableReps(
  supabase: SupabaseClient,
  organizationId: string,
  candidateIds: string[]
): Promise<number> {
  if (candidateIds.length === 0) return 0
  const { count } = await supabase
    .from('voice_agent_presence')
    .select('target_id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('status', 'available')
    .in('target_id', candidateIds)
  return count || 0
}

/**
 * Atomically claim the first free target from an ordered candidate list, seating
 * `callId` on it. Returns the claimed target_id, or null if none free. Wraps the
 * SKIP LOCKED RPC so the race protection lives in one place (the DB).
 */
export async function claimTarget(
  supabase: SupabaseClient,
  organizationId: string,
  candidateIds: string[],
  callId: string
): Promise<string | null> {
  if (candidateIds.length === 0) return null
  const { data, error } = await supabase.rpc('claim_available_transfer_target', {
    p_org_id: organizationId,
    p_candidate_ids: candidateIds,
    p_call_id: callId,
  })
  if (error) {
    logger.error('claimTarget RPC failed', { organizationId, callId }, new Error(error.message))
    return null
  }
  return (data as string | null) || null
}

/** Release a rep when their transferred call ends (or a hold is abandoned). */
export async function releaseTarget(supabase: SupabaseClient, targetId: string): Promise<void> {
  const { error } = await supabase.rpc('release_transfer_target', { p_target_id: targetId })
  if (error) logger.warn('releaseTarget RPC failed', { targetId, error: error.message })
}

/**
 * Turn a claimed target into a PSTN number Retell can transfer to. Returns null
 * if the target has no dialable number (e.g. a softphone rep with no phone set).
 */
export async function resolveTargetDestination(
  supabase: SupabaseClient,
  target: Pick<VoiceTransferTarget, 'kind' | 'destination' | 'user_id'>
): Promise<string | null> {
  if (target.kind === 'phone' || target.kind === 'sip') {
    return target.destination || null
  }
  if (target.kind === 'softphone_user' && target.user_id) {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('phone')
      .eq('id', target.user_id)
      .maybeSingle()
    const phone = (profile?.phone as string | null)?.replace(/[\s\-()]/g, '') || null
    return phone && /^\+?1?\d{10,15}$/.test(phone) ? phone : null
  }
  return null
}
