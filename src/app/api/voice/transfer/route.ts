/**
 * Live-Transfer Broker.
 *
 * POST /api/voice/transfer — called by the Retell agent's CUSTOM FUNCTION mid-call
 * (configured in the Retell dashboard) whenever the AI wants to hand the caller to
 * a live person. This endpoint does NOT place any call; it decides WHO (if anyone)
 * is free and returns a PSTN number for the agent's `transfer_call` tool to bridge.
 *
 * Contract the Retell function reads from the JSON response:
 *   { available: boolean,
 *     action: 'transfer' | 'hold' | 'wrap_up',
 *     transfer_to?: E164 string,   // present iff action==='transfer'
 *     target_name?: string,
 *     say: string }                // a line for the agent to speak
 *
 *   action='transfer' → agent says `say`, then calls transfer_call(transfer_to).
 *   action='hold'     → no rep free yet: agent keeps the caller engaged/qualifying
 *                       and calls this function again shortly.
 *   action='wrap_up'  → hold cap exceeded: agent gracefully books / takes a message.
 *
 * AUTH: a shared secret (Retell sends it as a configured header). This runs with
 * the service role, so the secret is the only thing standing between the public
 * internet and a claim on a rep — it fails closed if unset.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { applyDistributedRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { resolveTransferCandidates } from '@/lib/voice/transfer-routing'
import {
  loadActiveRoutes,
  ensurePresenceForOrg,
  claimTarget,
  resolveTargetDestination,
} from '@/lib/voice/transfer-presence'
import { logger } from '@/lib/logger'

const DEFAULT_HOLD_CAP_SECONDS = 120

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

/** Pull our retell_call_id out of whatever shape the Retell function sends. */
function extractRetellCallId(body: Record<string, unknown>): string | null {
  const call = body.call as Record<string, unknown> | undefined
  const args = body.args as Record<string, unknown> | undefined
  return (
    (call?.call_id as string) ||
    (body.call_id as string) ||
    (args?.call_id as string) ||
    (body.retell_call_id as string) ||
    null
  )
}

export async function POST(request: NextRequest) {
  // Fail closed: no secret configured → nobody gets transferred.
  const secret = process.env.VOICE_TRANSFER_FUNCTION_SECRET
  if (!secret) {
    logger.error('Transfer broker called but VOICE_TRANSFER_FUNCTION_SECRET is unset')
    return unauthorized()
  }
  const auth = request.headers.get('authorization') || ''
  const headerSecret = request.headers.get('x-transfer-secret') || auth.replace(/^Bearer\s+/i, '')
  if (headerSecret !== secret) {
    // Throttle credential-guessing WITHOUT ever rate-limiting valid Retell traffic:
    // the limiter is consumed only on a failed auth. (Valid callers skip it, so the
    // shared Retell egress IP + legitimate mid-call hold-polling are never capped.)
    const rl = await applyDistributedRateLimit(request, RATE_LIMITS.publicForm, 'voice-transfer-auth')
    return rl ?? unauthorized()
  }

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const retellCallId = extractRetellCallId(body)
  if (!retellCallId) {
    return NextResponse.json({ error: 'Missing call_id' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Resolve our call row (carries org, campaign, and hold-timer state).
  const { data: call } = await supabase
    .from('voice_calls')
    .select('id, organization_id, voice_campaign_id, transfer_status, transfer_requested_at, transferred_to_target_id')
    .eq('retell_call_id', retellCallId)
    .maybeSingle()

  if (!call) {
    logger.warn('Transfer broker: no voice_calls row for retell call', { retellCallId })
    return NextResponse.json({ error: 'Unknown call' }, { status: 404 })
  }

  const orgId = call.organization_id as string

  // Master gates: org toggle must be on.
  const { data: org } = await supabase
    .from('organizations')
    .select('voice_live_transfer_enabled, voice_live_transfer_max_hold_seconds')
    .eq('id', orgId)
    .maybeSingle()

  if (!org?.voice_live_transfer_enabled) {
    return NextResponse.json({
      available: false,
      action: 'wrap_up',
      say: "I'll take care of the next steps for you right now.",
    })
  }

  // Hold cap: org default, overridden per-campaign if set.
  let holdCap = org.voice_live_transfer_max_hold_seconds || DEFAULT_HOLD_CAP_SECONDS
  if (call.voice_campaign_id) {
    const { data: campaign } = await supabase
      .from('voice_campaigns')
      .select('max_hold_seconds')
      .eq('id', call.voice_campaign_id)
      .maybeSingle()
    if (campaign?.max_hold_seconds) holdCap = campaign.max_hold_seconds
  }

  // If we've been holding past the cap, tell the agent to wrap up gracefully.
  const requestedAt = call.transfer_requested_at ? new Date(call.transfer_requested_at as string) : null
  const heldSeconds = requestedAt ? Math.round((Date.now() - requestedAt.getTime()) / 1000) : 0
  if (requestedAt && heldSeconds >= holdCap) {
    await supabase
      .from('voice_calls')
      .update({ transfer_status: 'abandoned', hold_seconds: heldSeconds })
      .eq('id', call.id)
    return NextResponse.json({
      available: false,
      action: 'wrap_up',
      say: "Our team is with other patients right now — let me get your details and have a specialist call you right back.",
    })
  }

  // Resolve who should take the call at this moment, then try to claim one.
  await ensurePresenceForOrg(supabase, orgId)
  const routes = await loadActiveRoutes(supabase, orgId)
  const { primary, overflow } = resolveTransferCandidates(routes)

  // No target configured for this moment (e.g. after hours = all-AI) → don't make
  // the caller wait on hold; let the AI handle everything end to end.
  if (primary.length === 0 && overflow.length === 0) {
    await supabase.from('voice_calls').update({ transfer_status: 'none' }).eq('id', call.id)
    return NextResponse.json({
      available: false,
      action: 'wrap_up',
      say: "I can take care of everything you need right now — let's get you set up.",
    })
  }

  // Try in-window targets first, then overflow (concierge / answering service).
  let claimedTargetId = await claimTarget(supabase, orgId, primary, call.id as string)
  if (!claimedTargetId && overflow.length > 0) {
    claimedTargetId = await claimTarget(supabase, orgId, overflow, call.id as string)
  }

  // Nobody free → mark 'holding' (stamp the timer once) and tell the agent to hold.
  if (!claimedTargetId) {
    if (call.transfer_status !== 'holding') {
      await supabase
        .from('voice_calls')
        .update({
          transfer_status: 'holding',
          transfer_requested_at: requestedAt ? call.transfer_requested_at : new Date().toISOString(),
        })
        .eq('id', call.id)
    }
    return NextResponse.json({
      available: false,
      action: 'hold',
      say: "Let me get you to one of our specialists — while I do, tell me a bit more about what you're looking for.",
    })
  }

  // Got a rep. Resolve their number; if somehow undialable, release and hold.
  const { data: target } = await supabase
    .from('voice_transfer_targets')
    .select('id, name, kind, destination, user_id')
    .eq('id', claimedTargetId)
    .maybeSingle()

  const destination = target ? await resolveTargetDestination(supabase, target) : null
  if (!destination) {
    // Undialable target — hand the seat back so it isn't wedged, then hold.
    await supabase.rpc('release_transfer_target', { p_target_id: claimedTargetId })
    logger.warn('Claimed transfer target has no dialable number', { claimedTargetId })
    return NextResponse.json({
      available: false,
      action: 'hold',
      say: "One moment while I connect you.",
    })
  }

  await supabase
    .from('voice_calls')
    .update({
      transfer_status: 'bridged',
      transferred_to_target_id: claimedTargetId,
      transfer_bridged_at: new Date().toISOString(),
      hold_seconds: heldSeconds,
      outcome: 'transferred',
    })
    .eq('id', call.id)

  logger.info('Live transfer authorized', {
    call_id: call.id,
    target_id: claimedTargetId,
    held_seconds: heldSeconds,
  })

  return NextResponse.json({
    available: true,
    action: 'transfer',
    transfer_to: destination,
    target_name: (target?.name as string) || 'a specialist',
    say: "Great news — I have a specialist available. Connecting you now, one moment.",
  })
}
