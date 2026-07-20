/**
 * Smart List Resolver
 *
 * Converts SmartListCriteria JSONB into Supabase query filters.
 * Used by the Smart List leads endpoint and campaign auto-enrollment.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { SmartListCriteria } from '@/types/database'
import { combineTermMatches, sanitizeTerm } from './keyword-match'
import { serviceLineOrFilter } from '@/lib/leads/service-line'

const LEAD_TEXT_COLUMNS = [
  'first_name', 'last_name', 'city',
  'ai_summary', 'dental_condition_details', 'current_dental_situation',
] as const

/**
 * Resolve a keyword clause to the set of matching lead IDs (org-scoped).
 * One query per (term, scope); per-term sets union across scopes, then combine
 * across terms by `match` (any=union, all=intersect). Encryption-aware: only
 * plaintext columns + messages.body are searched (never encrypted email/phone).
 * Returns null when there is nothing to filter (no usable terms/scopes).
 */
export async function resolveKeywordLeadIds(
  supabase: SupabaseClient,
  organizationId: string,
  keywords: NonNullable<SmartListCriteria['keywords']>
): Promise<Set<string> | null> {
  const terms = keywords.terms.map(sanitizeTerm).filter((t) => t.length > 0)
  const scopes = keywords.scopes
  if (terms.length === 0 || scopes.length === 0) return null

  const perTerm: Set<string>[] = []

  for (const term of terms) {
    const ids = new Set<string>()

    if (scopes.includes('lead_fields')) {
      const orFilter = LEAD_TEXT_COLUMNS.map((c) => `${c}.ilike.%${term}%`).join(',')
      const { data } = await supabase
        .from('leads').select('id')
        .eq('organization_id', organizationId).or(orFilter).limit(5000)
      for (const r of data || []) ids.add((r as { id: string }).id)
    }

    if (scopes.includes('conversation')) {
      const { data } = await supabase
        .from('messages').select('lead_id')
        .eq('organization_id', organizationId).ilike('body', `%${term}%`).limit(10000)
      for (const r of data || []) { const id = (r as { lead_id: string | null }).lead_id; if (id) ids.add(id) }
    }

    if (scopes.includes('inbound_sms')) {
      const { data } = await supabase
        .from('messages').select('lead_id')
        .eq('organization_id', organizationId)
        .eq('direction', 'inbound').eq('channel', 'sms')
        .ilike('body', `%${term}%`).limit(10000)
      for (const r of data || []) { const id = (r as { lead_id: string | null }).lead_id; if (id) ids.add(id) }
    }

    if (scopes.includes('tags')) {
      const { data: tagRows } = await supabase
        .from('tags').select('id')
        .eq('organization_id', organizationId).ilike('name', `%${term}%`).limit(500)
      const tagIds = (tagRows || []).map((t) => (t as { id: string }).id)
      if (tagIds.length > 0) {
        const { data: links } = await supabase
          .from('lead_tags').select('lead_id')
          .eq('organization_id', organizationId).in('tag_id', tagIds).limit(10000)
        for (const r of links || []) ids.add((r as { lead_id: string }).lead_id)
      }
    }

    perTerm.push(ids)
  }

  return combineTermMatches(perTerm, keywords.match)
}

/**
 * Build a Supabase query from SmartListCriteria.
 * Returns the query with all filters applied (but no .select() or pagination).
 */
export function applySmartListCriteria(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
  criteria: SmartListCriteria
) {
  // Static snapshot: pin to an explicit ID set (Action Center cohorts et al).
  // Applied here — not in resolveSmartListLeads — so every criteria consumer
  // (list-leads endpoint, counts, eligibility, mass send) honors it.
  if (criteria.lead_ids && criteria.lead_ids.length > 0) {
    query = query.in('id', criteria.lead_ids.slice(0, 1000))
  }

  // Manual removals: leads the user pulled out by hand stay out no matter what
  // the other filters match. Applied here for the same reason as lead_ids —
  // every consumer (view, counts, sends, enrollment) must honor a removal.
  if (criteria.excluded_lead_ids && criteria.excluded_lead_ids.length > 0) {
    query = query.not(
      'id', 'in', `(${criteria.excluded_lead_ids.slice(0, 1000).join(',')})`
    )
  }

  // Status filter
  if (criteria.statuses && criteria.statuses.length > 0) {
    query = query.in('status', criteria.statuses)
  }

  // Status exclusion (NOT IN). Recommendation-built segments bar
  // disqualified/unresponsive leads this way so every consumer — list view,
  // counts, mass sends, campaign enrollment — honors the exclusion.
  if (criteria.exclude_statuses && criteria.exclude_statuses.length > 0) {
    query = query.not('status', 'in', `(${criteria.exclude_statuses.join(',')})`)
  }

  // AI qualification filter
  if (criteria.ai_qualifications && criteria.ai_qualifications.length > 0) {
    query = query.in('ai_qualification', criteria.ai_qualifications)
  }

  // Conversation analysis filters (written by the analyze-conversations sweep)
  if (criteria.conversation_intents && criteria.conversation_intents.length > 0) {
    query = query.in('conversation_intent', criteria.conversation_intents)
  }
  if (criteria.conversation_sentiments && criteria.conversation_sentiments.length > 0) {
    query = query.in('conversation_sentiment', criteria.conversation_sentiments)
  }
  if (criteria.primary_objections && criteria.primary_objections.length > 0) {
    query = query.in('primary_objection', criteria.primary_objections)
  }
  if (criteria.conversation_red_flag === true) {
    query = query.eq('conversation_red_flag', true)
  }

  // Score range
  if (typeof criteria.score_min === 'number') {
    query = query.gte('ai_score', criteria.score_min)
  }
  if (typeof criteria.score_max === 'number') {
    query = query.lte('ai_score', criteria.score_max)
  }

  // Pipeline stage filter
  if (criteria.stages && criteria.stages.length > 0) {
    query = query.in('stage_id', criteria.stages)
  }

  // Service line (treatment) filter. Not a column — a lead's line is derived
  // from treatment_interest + intake tags + campaign keywords, with implants as
  // the residual default. serviceLineOrFilter builds the PostgREST .or() group;
  // it ANDs with every other criterion (an unknown key yields null → no filter).
  if (typeof criteria.service_line === 'string' && criteria.service_line) {
    const orGroup = serviceLineOrFilter(criteria.service_line)
    if (orGroup) query = query.or(orGroup)
  }

  // Source type filter
  if (criteria.source_types && criteria.source_types.length > 0) {
    query = query.in('source_type', criteria.source_types)
  }

  // Engagement score range
  if (typeof criteria.engagement_min === 'number') {
    query = query.gte('engagement_score', criteria.engagement_min)
  }
  if (typeof criteria.engagement_max === 'number') {
    query = query.lte('engagement_score', criteria.engagement_max)
  }

  // Behavioral temperature bands (engagement sweep). ['cold','cooling'] is the
  // canonical re-warming pool; NULL rows (never graded) never match, which is
  // correct — a lead the sweep hasn't seen shouldn't enter a nurture campaign.
  if (criteria.engagement_temperatures && criteria.engagement_temperatures.length > 0) {
    query = query.in('engagement_temperature', criteria.engagement_temperatures)
  }

  // Location / state filter
  if (criteria.states && criteria.states.length > 0) {
    query = query.in('state', criteria.states)
  }

  // Date range
  if (criteria.created_after) {
    query = query.gte('created_at', criteria.created_after)
  }
  if (criteria.created_before) {
    query = query.lte('created_at', criteria.created_before)
  }

  // Contact recency (powers "needs follow-up" segments). A lead that has never
  // been contacted (last_contacted_at IS NULL) is maximally stale, so the
  // "before" filter deliberately includes nulls via an OR group. PostgREST ANDs
  // this .or() group with every other filter above.
  if (criteria.last_contacted_before) {
    query = query.or(
      `last_contacted_at.is.null,last_contacted_at.lt.${criteria.last_contacted_before}`
    )
  }
  if (criteria.never_contacted === true) {
    query = query.is('last_contacted_at', null)
  }

  // Contact info requirements
  if (criteria.has_phone === true) {
    query = query.not('phone_formatted', 'is', null)
  }
  if (criteria.has_email === true) {
    query = query.not('email', 'is', null)
  }

  // Consent requirements
  if (criteria.sms_consent === true) {
    query = query.eq('sms_consent', true).eq('sms_opt_out', false)
  }
  if (criteria.email_consent === true) {
    query = query.eq('email_consent', true).eq('email_opt_out', false)
  }

  // EHR reconciliation: exclude (false) or isolate (true) existing patients.
  if (typeof criteria.is_existing_patient === 'boolean') {
    query = query.eq('is_existing_patient', criteria.is_existing_patient)
  }

  // Closer workflow: deliberating deals and their follow-up timer.
  if (criteria.closing_temperatures && criteria.closing_temperatures.length > 0) {
    query = query.in('closing_temperature', criteria.closing_temperatures)
  }
  if (criteria.closing_follow_up_before) {
    // "Due" = has a timer set AND it has arrived. Nulls excluded on purpose.
    query = query
      .not('closing_follow_up_at', 'is', null)
      .lte('closing_follow_up_at', criteria.closing_follow_up_before)
  }

  return query
}

/**
 * Resolve a Smart List's criteria into matching lead IDs.
 * Handles tag filtering via the lead_tags junction table.
 */
export async function resolveSmartListLeads(
  supabase: SupabaseClient,
  organizationId: string,
  criteria: SmartListCriteria,
  options: { limit?: number; offset?: number; countOnly?: boolean } = {}
): Promise<{ leadIds: string[]; count: number }> {
  const { limit = 500, offset = 0, countOnly = false } = options

  // If we have tag criteria, we need to resolve tag-matching leads first
  let tagFilteredLeadIds: string[] | null = null

  if (criteria.tags && criteria.tags.ids.length > 0) {
    const { ids: tagIds, operator } = criteria.tags

    if (operator === 'and') {
      // AND: lead must have ALL specified tags
      // Get leads that have all the tags
      const { data: tagLinks } = await supabase
        .from('lead_tags')
        .select('lead_id, tag_id')
        .eq('organization_id', organizationId)
        .in('tag_id', tagIds)

      if (!tagLinks || tagLinks.length === 0) {
        return { leadIds: [], count: 0 }
      }

      // Group by lead_id and count matching tags
      const leadTagCounts = new Map<string, number>()
      for (const link of tagLinks) {
        leadTagCounts.set(link.lead_id, (leadTagCounts.get(link.lead_id) || 0) + 1)
      }

      // Only keep leads that have ALL tags
      tagFilteredLeadIds = Array.from(leadTagCounts.entries())
        .filter(([, count]) => count >= tagIds.length)
        .map(([leadId]) => leadId)

      if (tagFilteredLeadIds.length === 0) {
        return { leadIds: [], count: 0 }
      }
    } else {
      // OR: lead must have ANY of the specified tags
      const { data: tagLinks } = await supabase
        .from('lead_tags')
        .select('lead_id')
        .eq('organization_id', organizationId)
        .in('tag_id', tagIds)

      if (!tagLinks || tagLinks.length === 0) {
        return { leadIds: [], count: 0 }
      }

      tagFilteredLeadIds = [...new Set(tagLinks.map((l) => l.lead_id))]
    }
  }

  // Keyword pre-filter (same pattern as tags): resolve to lead IDs and intersect.
  if (criteria.keywords) {
    const kwSet = await resolveKeywordLeadIds(supabase, organizationId, criteria.keywords)
    if (kwSet !== null) {
      if (kwSet.size === 0) return { leadIds: [], count: 0 }
      if (tagFilteredLeadIds !== null) {
        tagFilteredLeadIds = tagFilteredLeadIds.filter((id) => kwSet.has(id))
        if (tagFilteredLeadIds.length === 0) return { leadIds: [], count: 0 }
      } else {
        tagFilteredLeadIds = [...kwSet]
      }
    }
  }

  // Build the main leads query
  let query = supabase
    .from('leads')
    .select('id', { count: 'exact' })
    .eq('organization_id', organizationId)

  // Apply tag filter if we have one
  if (tagFilteredLeadIds !== null) {
    // Supabase .in() has a practical limit, batch if needed
    if (tagFilteredLeadIds.length > 0) {
      query = query.in('id', tagFilteredLeadIds.slice(0, 1000))
    } else {
      return { leadIds: [], count: 0 }
    }
  }

  // Apply all other criteria
  query = applySmartListCriteria(query, criteria)

  if (countOnly) {
    const { count } = await query
    return { leadIds: [], count: count || 0 }
  }

  // Paginate
  query = query.range(offset, offset + limit - 1).order('created_at', { ascending: false })

  const { data, count } = await query

  return {
    leadIds: (data || []).map((l: { id: string }) => l.id),
    count: count || 0,
  }
}
