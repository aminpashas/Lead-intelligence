/**
 * Rule-Set Stamping
 *
 * Every autonomously sent AI message records WHICH agency rules were live when
 * it was generated (a short hash + the rule ids in messages.metadata.rule_set).
 * That stamp is what lets the weekly performance pass compare outcomes across
 * rule cohorts — without it, "did this learned rule actually help?" is
 * unanswerable after the fact.
 */

import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

export type RuleSetStamp = {
  version: string
  rule_ids: string[]
}

export function computeRuleSetVersion(ruleIds: string[]): string {
  const sorted = [...ruleIds].sort()
  return createHash('sha1').update(sorted.join(',')).digest('hex').slice(0, 12)
}

/**
 * Snapshot the currently enabled agency rules. Returns null when there are no
 * enabled rules (nothing to attribute) or on read failure — stamping must
 * never block a send.
 */
export async function getActiveRuleSetStamp(supabase: SupabaseClient): Promise<RuleSetStamp | null> {
  try {
    const { data } = await supabase
      .from('agency_ai_rules')
      .select('id')
      .eq('is_enabled', true)
    const ids = (data || []).map((r: { id: string }) => r.id)
    if (ids.length === 0) return null
    return { version: computeRuleSetVersion(ids), rule_ids: ids.sort() }
  } catch {
    return null
  }
}
