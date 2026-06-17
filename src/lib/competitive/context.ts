/**
 * Competitor + negotiation context wiring (Phase 4).
 *
 * - persistCompetitorMentions: run detection over an inbound message and record
 *   matches (called from the inbound pipeline, gated by the competitor_intel flag).
 * - loadCompetitorContext: assemble the distinct competitors a lead mentioned,
 *   with our positioning, for the Closer prompt.
 * - negotiationLeversForProfile: map the lead's price sensitivity → approved levers.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { detectCompetitorMentions, type CompetitorRef } from './detect'
import {
  selectNegotiationLevers,
  type NegotiationLever,
  type NegotiationPolicy,
  type PriceSensitivity,
} from '@/lib/ai/negotiation'
import type { CompetitorContext } from '@/lib/ai/agent-types'

// Default authorized levers until a per-org negotiation policy table exists.
// in_house_plan is intentionally excluded (more sensitive — opt-in later).
const DEFAULT_NEGOTIATION_POLICY: NegotiationPolicy = {
  enabledLevers: ['scheduling_incentive', 'phased_treatment', 'extend_financing_term'],
}

export async function persistCompetitorMentions(
  supabase: SupabaseClient,
  p: { leadId: string; organizationId: string; text: string }
): Promise<number> {
  const { data: comps } = await supabase
    .from('competitors')
    .select('id, name, aliases')
    .eq('organization_id', p.organizationId)
  if (!comps || comps.length === 0) return 0

  const matches = detectCompetitorMentions(p.text, comps as CompetitorRef[])
  if (matches.length === 0) return 0

  await supabase.from('lead_competitor_mentions').insert(
    matches.map((m) => ({
      organization_id: p.organizationId,
      lead_id: p.leadId,
      competitor_id: m.competitorId,
      matched_term: m.matchedTerm,
      quote: p.text.slice(0, 300),
    }))
  )
  return matches.length
}

export async function loadCompetitorContext(
  supabase: SupabaseClient,
  leadId: string,
  organizationId: string
): Promise<CompetitorContext[]> {
  const { data: mentions } = await supabase
    .from('lead_competitor_mentions')
    .select('competitors:competitor_id ( name, our_differentiators, typical_pricing_notes, weaknesses )')
    .eq('lead_id', leadId)
    .eq('organization_id', organizationId)
    .order('detected_at', { ascending: false })
    .limit(25)
  if (!mentions || mentions.length === 0) return []

  const seen = new Set<string>()
  const out: CompetitorContext[] = []
  type CompRow = { competitors: Record<string, string | null> | Record<string, string | null>[] | null }
  for (const row of mentions as unknown as CompRow[]) {
    // PostgREST embeds a to-one relation as an object, but types can widen to an array.
    const c = Array.isArray(row.competitors) ? row.competitors[0] : row.competitors
    if (!c?.name || seen.has(c.name)) continue
    seen.add(c.name)
    out.push({
      name: c.name,
      our_differentiators: c.our_differentiators ?? null,
      typical_pricing_notes: c.typical_pricing_notes ?? null,
      weaknesses: c.weaknesses ?? null,
    })
  }
  return out
}

/** Map a patient profile's price sensitivity → the approved negotiation levers. */
export function negotiationLeversForProfile(
  patientProfile: unknown
): NegotiationLever[] {
  const sensitivity = (
    patientProfile as { negotiation_profile?: { price_sensitivity?: string } } | null
  )?.negotiation_profile?.price_sensitivity as PriceSensitivity | undefined
  if (sensitivity !== 'low' && sensitivity !== 'medium' && sensitivity !== 'high') return []
  return selectNegotiationLevers(DEFAULT_NEGOTIATION_POLICY, sensitivity)
}
