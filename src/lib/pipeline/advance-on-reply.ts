/**
 * Auto-advance a lead's pipeline stage when they actually reply.
 *
 * A lead who is texting/emailing us must not keep sitting in the un-worked
 * "No Communication" queue (or "New Lead"): the conversation-header status pill
 * and the pipeline board both read `leads.stage_id`, so a stale stage there
 * reads as "we've never heard from this person" while their messages sit right
 * above it. This is the lightweight, zero-AI counterpart to processEncounter's
 * stage logic (encounter-processor.ts) — cheap enough to call on every inbound
 * webhook, where the full encounter pipeline never runs.
 *
 * The funnel decision itself lives in `nextStageForEncounter` (pure, monotonic,
 * never moves a lead backward and leaves already-advanced or suppression stages
 * untouched). The actual move routes through `applyStageMove` so it means the
 * same thing as a hand-dragged move: one audited `stage_changed` activity plus
 * the funnel/campaign automations for entering "Engaged".
 *
 * Call sites are responsible for NOT invoking this on administrative replies
 * (STOP/START and other consent keywords) — those are opt-out/opt-in signals,
 * not engagement.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { nextStageForEncounter } from './encounter-stage'
import { applyStageMove } from './stage-move'

export type AdvanceOnReplyArgs = {
  leadId: string
  organizationId: string
  /** Channel the inbound message arrived on. */
  channel: 'sms' | 'email' | 'voice' | string
}

/**
 * Best-effort: resolves the lead's current funnel position, asks
 * `nextStageForEncounter` where an inbound reply should land it, and applies
 * the move if that's genuinely forward. A no-op when the lead is already at or
 * beyond the target stage, when the org has no matching stage row, or when the
 * lead sits in a stage the funnel logic deliberately leaves alone.
 *
 * Never throws — a stage nudge must not fail the webhook that persisted the
 * message. Callers may ignore the returned promise.
 */
export async function advanceStageOnInboundReply(
  supabase: SupabaseClient,
  args: AdvanceOnReplyArgs,
): Promise<void> {
  try {
    const { data: lead } = await supabase
      .from('leads')
      .select('stage_id')
      .eq('id', args.leadId)
      .eq('organization_id', args.organizationId)
      .maybeSingle()

    const fromStageId = (lead?.stage_id as string | null) ?? null

    // Resolve the current stage's slug — that's what the funnel logic ranks on.
    let currentStageSlug: string | null = null
    if (fromStageId) {
      const { data: cur } = await supabase
        .from('pipeline_stages')
        .select('slug')
        .eq('id', fromStageId)
        .maybeSingle()
      currentStageSlug = (cur?.slug as string) ?? null
    }

    const targetSlug = nextStageForEncounter({
      channel: args.channel,
      inbound: true,
      appointmentBooked: false,
      durationSeconds: null,
      currentStageSlug,
    })
    if (!targetSlug) return // already engaged+, or a stage we don't touch.

    const { data: target } = await supabase
      .from('pipeline_stages')
      .select('id')
      .eq('organization_id', args.organizationId)
      .eq('slug', targetSlug)
      .maybeSingle()
    const toStageId = (target?.id as string | undefined) ?? undefined
    if (!toStageId || toStageId === fromStageId) return

    await applyStageMove(supabase, {
      organizationId: args.organizationId,
      leadIds: [args.leadId],
      toStageId,
      actor: { type: 'system', source: 'inbound_reply' },
      knownFromStageId: fromStageId,
      activityTitle: 'Advanced on inbound reply',
    })
  } catch {
    /* Best effort — a stage nudge must never fail the message webhook. */
  }
}
