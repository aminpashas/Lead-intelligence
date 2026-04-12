/**
 * Smart List Resolver
 *
 * Converts SmartListCriteria JSONB into Supabase query filters.
 * Used by the Smart List leads endpoint and campaign auto-enrollment.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { SmartListCriteria } from '@/types/database'

/**
 * Build a Supabase query from SmartListCriteria.
 * Returns the query with all filters applied (but no .select() or pagination).
 */
export function applySmartListCriteria(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
  criteria: SmartListCriteria
) {
  // Status filter
  if (criteria.statuses && criteria.statuses.length > 0) {
    query = query.in('status', criteria.statuses)
  }

  // AI qualification filter
  if (criteria.ai_qualifications && criteria.ai_qualifications.length > 0) {
    query = query.in('ai_qualification', criteria.ai_qualifications)
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
