/**
 * Learning Episodes — outcome detection + journey assembly
 *
 * An episode is a labeled training example: the FULL communication journey of
 * one lead (across SMS/email/voice transcripts stored in messages) snapshotted
 * at the moment a real outcome landed. The nightly cron detects fresh outcomes
 * and backtracks the conversation into learning_episodes; the weekly
 * distillation pass then contrasts won vs lost cohorts.
 *
 * All journey stats are computed HERE, in code — the distillation LLM only
 * ever sees aggregates and a handful of scrubbed example snippets. That keeps
 * the learning loop on the "LLM writes prose, code decides what's true" side.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  LearningOutcome,
  LearningJourneyEntry,
  LearningJourneyStats,
} from '@/types/database'

export type OutcomeEvent = {
  organization_id: string
  lead_id: string
  outcome: LearningOutcome
  outcome_at: string
  outcome_ref: string
}

const JOURNEY_MESSAGE_CAP = 200
const BODY_TRUNCATE = 400

/**
 * Light PHI hygiene for journey bodies: strip emails and long digit runs
 * (phones, DOBs, SSNs). Bodies also get truncated. This is defense-in-depth —
 * the distillation prompt additionally forbids echoing personal details.
 */
export function scrubBody(body: string): string {
  return body
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]')
    .slice(0, BODY_TRUNCATE)
}

/**
 * Find outcome events that landed since `sinceIso`. Each maps to one episode.
 * Windows overlap across runs on purpose — assembly upserts on the natural key
 * (lead_id, outcome, outcome_ref) so re-detection is idempotent.
 */
export async function detectOutcomeEvents(
  supabase: SupabaseClient,
  sinceIso: string
): Promise<OutcomeEvent[]> {
  const events: OutcomeEvent[] = []

  // booked — any appointment created in the window
  const { data: booked } = await supabase
    .from('appointments')
    .select('id, organization_id, lead_id, created_at')
    .gte('created_at', sinceIso)
    .limit(500)
  for (const a of booked || []) {
    if (!a.lead_id) continue
    events.push({
      organization_id: a.organization_id,
      lead_id: a.lead_id,
      outcome: 'booked',
      outcome_at: a.created_at,
      outcome_ref: a.id,
    })
  }

  // showed — appointment completed in the window
  const { data: showed } = await supabase
    .from('appointments')
    .select('id, organization_id, lead_id, completed_at')
    .eq('status', 'completed')
    .gte('completed_at', sinceIso)
    .limit(500)
  for (const a of showed || []) {
    if (!a.lead_id || !a.completed_at) continue
    events.push({
      organization_id: a.organization_id,
      lead_id: a.lead_id,
      outcome: 'showed',
      outcome_at: a.completed_at,
      outcome_ref: a.id,
    })
  }

  // no_show — no_show_at stamped in the window
  const { data: noShows } = await supabase
    .from('appointments')
    .select('id, organization_id, lead_id, no_show_at')
    .not('no_show_at', 'is', null)
    .gte('no_show_at', sinceIso)
    .limit(500)
  for (const a of noShows || []) {
    if (!a.lead_id) continue
    events.push({
      organization_id: a.organization_id,
      lead_id: a.lead_id,
      outcome: 'no_show',
      outcome_at: a.no_show_at,
      outcome_ref: a.id,
    })
  }

  // contract_signed / lost — from the activity feed
  const { data: activities } = await supabase
    .from('lead_activities')
    .select('id, organization_id, lead_id, activity_type, created_at')
    .in('activity_type', ['contract_signed', 'disqualified'])
    .gte('created_at', sinceIso)
    .limit(500)
  for (const act of activities || []) {
    if (!act.lead_id) continue
    events.push({
      organization_id: act.organization_id,
      lead_id: act.lead_id,
      outcome: act.activity_type === 'contract_signed' ? 'contract_signed' : 'lost',
      outcome_at: act.created_at,
      outcome_ref: act.id,
    })
  }

  return events
}

type MessageRow = {
  direction: string
  channel: string | null
  body: string | null
  created_at: string
  sender_type: string | null
  ai_generated: boolean | null
  metadata: Record<string, unknown> | null
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function computeJourneyStats(
  messages: MessageRow[],
  techniques: string[],
  engagementTemps: number[]
): LearningJourneyStats {
  const inbound = messages.filter((m) => m.direction === 'inbound')
  const outbound = messages.filter((m) => m.direction === 'outbound')
  const aiOutbound = outbound.filter((m) => m.ai_generated || m.sender_type === 'ai')

  // Response latencies: minutes from each inbound to the next outbound
  const latencies: number[] = []
  for (const inMsg of inbound) {
    const inAt = new Date(inMsg.created_at).getTime()
    const reply = outbound.find((o) => new Date(o.created_at).getTime() > inAt)
    if (reply) {
      latencies.push((new Date(reply.created_at).getTime() - inAt) / 60000)
    }
  }

  const firstAt = messages.length ? new Date(messages[0].created_at).getTime() : 0
  const lastAt = messages.length ? new Date(messages[messages.length - 1].created_at).getTime() : 0

  const ruleVersions = new Set<string>()
  for (const m of messages) {
    const rs = m.metadata?.rule_set as { version?: string } | undefined
    if (rs?.version) ruleVersions.add(rs.version)
  }

  return {
    inbound_count: inbound.length,
    outbound_count: outbound.length,
    ai_outbound_count: aiOutbound.length,
    ai_share: outbound.length > 0 ? aiOutbound.length / outbound.length : 0,
    first_response_minutes: latencies.length > 0 ? Math.round(latencies[0]) : null,
    median_response_minutes: latencies.length > 0 ? Math.round(median(latencies)!) : null,
    days_span: messages.length > 1 ? Math.round((lastAt - firstAt) / 86400000) : 0,
    techniques_used: [...new Set(techniques)],
    rule_set_versions: [...ruleVersions],
    engagement_first: engagementTemps.length > 0 ? engagementTemps[0] : null,
    engagement_last: engagementTemps.length > 0 ? engagementTemps[engagementTemps.length - 1] : null,
  }
}

/**
 * Backtrack the lead's full communication history up to the outcome moment and
 * upsert one labeled episode.
 */
export async function assembleEpisode(
  supabase: SupabaseClient,
  event: OutcomeEvent
): Promise<void> {
  const [{ data: messages }, { data: techniqueRows }, { data: assessments }] = await Promise.all([
    supabase
      .from('messages')
      .select('direction, channel, body, created_at, sender_type, ai_generated, metadata')
      .eq('lead_id', event.lead_id)
      .lte('created_at', event.outcome_at)
      .order('created_at', { ascending: true })
      .limit(JOURNEY_MESSAGE_CAP),
    supabase
      .from('message_technique_tracking')
      .select('technique_id')
      .eq('lead_id', event.lead_id)
      .lte('created_at', event.outcome_at),
    supabase
      .from('lead_engagement_assessments')
      .select('engagement_temperature, created_at')
      .eq('lead_id', event.lead_id)
      .lte('created_at', event.outcome_at)
      .order('created_at', { ascending: true }),
  ])

  const messageRows = (messages || []) as MessageRow[]

  const journey: LearningJourneyEntry[] = messageRows.map((m) => {
    const ruleSet = m.metadata?.rule_set as { version?: string } | undefined
    return {
      at: m.created_at,
      role: m.direction === 'inbound' ? 'patient' : m.ai_generated || m.sender_type === 'ai' ? 'ai' : 'staff',
      channel: m.channel || 'sms',
      body: scrubBody(m.body || ''),
      ...(ruleSet?.version ? { rule_set_version: ruleSet.version } : {}),
    }
  })

  const stats = computeJourneyStats(
    messageRows,
    (techniqueRows || []).map((t: { technique_id: string }) => t.technique_id),
    (assessments || []).map((a: { engagement_temperature: number }) => a.engagement_temperature)
  )

  await supabase.from('learning_episodes').upsert(
    {
      organization_id: event.organization_id,
      lead_id: event.lead_id,
      outcome: event.outcome,
      outcome_at: event.outcome_at,
      outcome_ref: event.outcome_ref,
      journey,
      journey_stats: stats,
      message_count: messageRows.length,
    },
    { onConflict: 'lead_id,outcome,outcome_ref' }
  )
}
