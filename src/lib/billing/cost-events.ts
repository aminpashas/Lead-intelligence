/**
 * Cost-event ledger writer.
 *
 * Pure row-builders (`buildSmsCostEvent`, `buildVoiceCostEvent`) turn provider facts into a
 * `cost_events` row with cost + billable + markup snapshot. The async wrappers persist them
 * idempotently by (service, external_id) so an estimate can later be upgraded to a final, and
 * webhook/cron retries never double-count.
 *
 * All writes are fire-and-forget observability — they must never throw into the caller's path.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { estimateSmsCents, estimateSmsSegments } from './pricing'
import { computeBillable, type MarkupConfig } from './markup'

export type CostEventService = 'sms' | 'voice' | 'email'

export type CostEventInsert = {
  organization_id: string
  service: CostEventService
  status: 'estimated' | 'final'
  event_at?: string
  source_table?: string | null
  source_id?: string | null
  external_id?: string | null
  quantity?: number | null
  unit?: string | null
  cost_cents: number
  billable_cents: number
  markup_pct: number | null
  metadata?: Record<string, unknown>
}

// ── Pure builders ────────────────────────────────────────────

export function buildSmsCostEvent(args: {
  organizationId: string
  externalId: string | null
  status: 'estimated' | 'final'
  /** Body used to estimate segments when `segments` is not supplied. */
  body?: string
  /** Twilio num_segments (authoritative when finalizing). */
  segments?: number
  /** Provider cost in cents (Twilio |price|); estimated from segments when omitted. */
  costCents?: number
  markup?: MarkupConfig
  leadId?: string | null
  sourceId?: string | null
}): CostEventInsert {
  const segments = args.segments ?? (args.body ? estimateSmsSegments(args.body) : 1)
  const costCents = args.costCents ?? estimateSmsCents(segments)
  const { billableCents, markupPct } = computeBillable(costCents, 'sms', args.markup)
  return {
    organization_id: args.organizationId,
    service: 'sms',
    status: args.status,
    external_id: args.externalId,
    source_table: 'messages',
    source_id: args.sourceId ?? null,
    quantity: segments,
    unit: 'segments',
    cost_cents: costCents,
    billable_cents: billableCents,
    markup_pct: markupPct,
    metadata: args.leadId ? { lead_id: args.leadId } : {},
  }
}

export function buildVoiceCostEvent(args: {
  organizationId: string
  externalId: string
  seconds: number
  /** Provider cost in cents (Retell call_cost.combined_cost). */
  costCents: number
  markup?: MarkupConfig
  leadId?: string | null
  sourceId?: string | null
}): CostEventInsert {
  const { billableCents, markupPct } = computeBillable(args.costCents, 'voice', args.markup)
  return {
    organization_id: args.organizationId,
    service: 'voice',
    status: 'final',
    external_id: args.externalId,
    source_table: 'voice_calls',
    source_id: args.sourceId ?? null,
    quantity: args.seconds,
    unit: 'seconds',
    cost_cents: args.costCents,
    billable_cents: billableCents,
    markup_pct: markupPct,
    metadata: args.leadId ? { lead_id: args.leadId } : {},
  }
}

// ── I/O ──────────────────────────────────────────────────────

/** Load a practice's markup overrides (null → platform defaults apply). */
export async function loadMarkupConfig(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<MarkupConfig> {
  try {
    const { data } = await supabase
      .from('billing_settings')
      .select('markups')
      .eq('organization_id', organizationId)
      .maybeSingle()
    return data ? { markups: data.markups as Record<string, number> } : null
  } catch {
    return null
  }
}

/**
 * Persist a cost event. Upserts by (service, external_id) so an "estimated" row is upgraded
 * in place to "final", and reconciliation retries are idempotent. Never throws.
 */
export async function recordCostEvent(supabase: SupabaseClient, row: CostEventInsert): Promise<void> {
  try {
    if (row.external_id) {
      await supabase.from('cost_events').upsert(row, { onConflict: 'service,external_id' })
    } else {
      await supabase.from('cost_events').insert(row)
    }
  } catch {
    // Observability only — cost logging must never break the send/webhook path.
  }
}

/** Convenience: record an estimated SMS cost at send time. */
export async function recordSmsEstimate(
  supabase: SupabaseClient,
  args: { organizationId: string; sid: string | null; body: string; leadId?: string | null },
): Promise<void> {
  if (!args.sid) return
  const markup = await loadMarkupConfig(supabase, args.organizationId)
  await recordCostEvent(
    supabase,
    buildSmsCostEvent({
      organizationId: args.organizationId,
      externalId: args.sid,
      body: args.body,
      status: 'estimated',
      markup,
      leadId: args.leadId ?? null,
    }),
  )
}

/** Convenience: record the final voice cost from a Retell call-ended webhook. */
export async function recordVoiceFinal(
  supabase: SupabaseClient,
  args: { organizationId: string; retellCallId: string; seconds: number; costCents: number; leadId?: string | null },
): Promise<void> {
  const markup = await loadMarkupConfig(supabase, args.organizationId)
  await recordCostEvent(
    supabase,
    buildVoiceCostEvent({
      organizationId: args.organizationId,
      externalId: args.retellCallId,
      seconds: args.seconds,
      costCents: args.costCents,
      markup,
      leadId: args.leadId ?? null,
    }),
  )
}
