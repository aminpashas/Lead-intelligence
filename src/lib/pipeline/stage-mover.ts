/**
 * Appointment-lifecycle stage automation.
 *
 * Unlike suggest-stage (which only proposes moves for human approval), this
 * HARD-moves the kanban card on concrete appointment events: booked → the
 * consult stage, canceled/no-show → the re-engage stage. Same guardrails as
 * the suggester: never touch a lead parked in a won/lost stage, never target
 * a won/lost stage, no-op when the org has no matching stage.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { PipelineStage } from '@/types/database'
import { logger } from '@/lib/logger'

export type AppointmentStageEvent = 'booked' | 'canceled' | 'no_show'

const EVENT_STAGE_PATTERNS: Record<AppointmentStageEvent, RegExp> = {
  booked: /consult|schedul|book|appoint/i,
  canceled: /no.?show|re.?engage|nurtur/i,
  no_show: /no.?show|re.?engage|nurtur/i,
}

export type StageResolution =
  | { stage: PipelineStage }
  | { skip: 'won_lost_stage' | 'no_matching_stage' | 'already_in_stage' }

/** Pure stage resolution — unit-tested; the effectful mover below just executes it. */
export function resolveStageForEvent(
  stages: PipelineStage[],
  event: AppointmentStageEvent,
  currentStageId: string | null
): StageResolution {
  const current = stages.find((s) => s.id === currentStageId)
  if (current && (current.is_won || current.is_lost)) return { skip: 'won_lost_stage' }

  const re = EVENT_STAGE_PATTERNS[event]
  const target = stages.find(
    (s) => !s.is_won && !s.is_lost && (re.test(s.slug ?? '') || re.test(s.name ?? ''))
  )
  if (!target) return { skip: 'no_matching_stage' }
  if (target.id === currentStageId) return { skip: 'already_in_stage' }
  return { stage: target }
}

/**
 * Lead statuses AT or PAST a completed consult. Webhook automations must never
 * regress a lead that has already progressed beyond consultation — an EHR event
 * (rebook, no-show record) says nothing about the sales pipeline after that point.
 */
const AT_OR_PAST_CONSULT_STATUSES: ReadonlySet<string> = new Set([
  'consultation_completed',
  'treatment_presented',
  'financing',
  'contract_sent',
  'contract_signed',
  'scheduled',
  'in_treatment',
  'completed',
  'lost',
  'disqualified',
])

/**
 * True while the lead hasn't completed a consult yet (new/contacted/qualified/
 * consultation_scheduled/no_show/unresponsive/dormant). Note: 'consultation_scheduled'
 * counts as pre-consult — the consult hasn't happened, so scheduled → no_show is a
 * legal transition. Callers guarding a move TO consultation_scheduled should
 * additionally skip when the status is already 'consultation_scheduled'.
 */
export function isPreConsultStatus(status: string): boolean {
  return !AT_OR_PAST_CONSULT_STATUSES.has(status)
}

/**
 * Map an EHR appointment event to a stage event. Prefers the appointment's own
 * status text (CareStack sends cancellations as 'Status' events whose trigger
 * name says nothing); falls back to the trigger name for create/reschedule.
 */
export function mapEhrEventToStageEvent(
  trigger: string,
  appointmentStatus?: string | null
): AppointmentStageEvent | null {
  const status = (appointmentStatus ?? '').toLowerCase()
  if (/no.?show|missed/.test(status)) return 'no_show'
  if (/cancel|delet/.test(status)) return 'canceled'
  const t = trigger.toLowerCase()
  if (/cancel|delet/.test(t)) return 'canceled'
  if (/no.?show|missed/.test(t)) return 'no_show'
  if (/creat|schedul|book|resched|confirm/.test(t) || /schedul|confirm|book/.test(status)) return 'booked'
  return null
}

/**
 * Move a lead's pipeline stage for an appointment event. Non-fatal by design:
 * every failure is logged and swallowed so it can never block a booking flow.
 * Call sites invoke it fire-and-forget (`void moveLeadStageForAppointmentEvent(...)`).
 */
export async function moveLeadStageForAppointmentEvent(
  supabase: SupabaseClient,
  params: { orgId: string; leadId: string; event: AppointmentStageEvent }
): Promise<{ moved: boolean; stageId?: string; reason?: string }> {
  const { orgId, leadId, event } = params
  try {
    const [{ data: lead }, { data: stages }] = await Promise.all([
      supabase
        .from('leads')
        .select('stage_id')
        .eq('id', leadId)
        .eq('organization_id', orgId)
        .maybeSingle(),
      supabase.from('pipeline_stages').select('*').eq('organization_id', orgId).order('position'),
    ])
    if (!lead || !stages || stages.length === 0) {
      return { moved: false, reason: 'lead_or_stages_missing' }
    }

    const resolution = resolveStageForEvent(stages as PipelineStage[], event, lead.stage_id ?? null)
    if ('skip' in resolution) return { moved: false, reason: resolution.skip }

    const { error } = await supabase
      .from('leads')
      .update({ stage_id: resolution.stage.id })
      .eq('id', leadId)
      .eq('organization_id', orgId)
    if (error) {
      logger.error('stage-mover update failed', { leadId, event, error: error.message })
      return { moved: false, reason: error.message }
    }

    // 'stage_changed' (not a bespoke type) — lead_activities.activity_type has a
    // CHECK whitelist (migration 002); the automation is recorded in metadata.
    await supabase.from('lead_activities').insert({
      organization_id: orgId,
      lead_id: leadId,
      activity_type: 'stage_changed',
      title: `Moved to "${resolution.stage.name}" (appointment ${event.replace('_', '-')})`,
      metadata: {
        automated: true,
        event,
        from_stage_id: lead.stage_id ?? null,
        to_stage_id: resolution.stage.id,
      },
    })

    return { moved: true, stageId: resolution.stage.id }
  } catch (err) {
    logger.error('stage-mover failed', {
      leadId,
      event,
      error: err instanceof Error ? err.message : String(err),
    })
    return { moved: false, reason: 'exception' }
  }
}
