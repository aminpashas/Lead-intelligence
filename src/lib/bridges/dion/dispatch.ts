/**
 * Single routing table for inbound Dion bus events.
 *
 * Both the live receiver (/api/bus/receive) and the reprocess cron
 * (/api/cron/dion-inbox-reprocess) dispatch through here, so a newly consumed
 * family can never be wired into one path and forgotten in the other — a drift
 * that would silently strand replayed events in dion_inbox forever.
 *
 * Handlers must throw ONLY on transient failures (the row stays unprocessed and
 * is retried); a "not matched / nothing to do" result is a returned status.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DionConsumedEvent } from './consumed'
import { handleEncounterSummarized } from '../dion-encounter-brief'
import { handleLeadCaptured } from '../dion-social-lead'

export type DispatchOutcome = { status: string; [key: string]: unknown }

export async function dispatchConsumedEvent(
  supabase: SupabaseClient,
  event: DionConsumedEvent,
): Promise<DispatchOutcome> {
  switch (event.type) {
    case 'clinical.scribe_completed':
    case 'clinical.encounter_completed':
      return handleEncounterSummarized(supabase, event)
    case 'lead.captured':
      return handleLeadCaptured(supabase, event)
    default: {
      // Exhaustiveness: adding a family to the consumed catalog without a handler
      // is a compile error here, not a silent no-op at runtime.
      const _never: never = event
      return { status: 'unhandled', type: (_never as { type: string }).type }
    }
  }
}
