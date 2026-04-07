import { createServiceClient } from '@/lib/supabase/server'

export type DisqualificationRule = {
  id: string
  name: string
  description: string
  condition: (lead: Record<string, unknown>) => boolean
  action: 'disqualify' | 'mark_cold' | 'mark_unresponsive'
  reason: string
}

// Default disqualification rules
export const defaultRules: Omit<DisqualificationRule, 'id'>[] = [
  {
    name: 'No Response After 14 Days',
    description: 'Lead has not responded to any messages after 14 days of first contact',
    condition: (lead) => {
      if (!lead.first_contact_at) return false
      if (lead.total_messages_received && (lead.total_messages_received as number) > 0) return false
      const daysSinceContact = (Date.now() - new Date(lead.first_contact_at as string).getTime()) / (1000 * 60 * 60 * 24)
      return daysSinceContact > 14 && (lead.total_messages_sent as number) >= 3
    },
    action: 'mark_unresponsive',
    reason: 'No response after 14 days and 3+ contact attempts',
  },
  {
    name: 'Multiple No-Shows',
    description: 'Lead has missed 2 or more scheduled appointments',
    condition: (lead) => {
      return (lead.no_show_count as number) >= 2
    },
    action: 'disqualify',
    reason: 'Multiple no-shows (2+)',
  },
  {
    name: 'Very Low AI Score After Engagement',
    description: 'Lead scored below 15 after at least 5 message exchanges',
    condition: (lead) => {
      const totalMessages = ((lead.total_messages_sent as number) || 0) + ((lead.total_messages_received as number) || 0)
      return (lead.ai_score as number) < 15 && totalMessages >= 5
    },
    action: 'disqualify',
    reason: 'Very low AI qualification score after engagement',
  },
  {
    name: 'Unresponsive Cold Lead',
    description: 'Cold-scored lead with no response in 30 days',
    condition: (lead) => {
      if (lead.ai_qualification !== 'cold') return false
      if (!lead.last_contacted_at) return false
      const daysSinceContact = (Date.now() - new Date(lead.last_contacted_at as string).getTime()) / (1000 * 60 * 60 * 24)
      return daysSinceContact > 30 && !(lead.last_responded_at)
    },
    action: 'mark_unresponsive',
    reason: 'Cold lead, no response in 30+ days',
  },
]

/**
 * Run disqualification rules against all active leads for an organization.
 * Intended to be called by a cron job (e.g., daily at midnight).
 */
export async function runDisqualificationRules(organizationId: string) {
  const supabase = createServiceClient()

  // Fetch active leads
  const { data: leads } = await supabase
    .from('leads')
    .select('*')
    .eq('organization_id', organizationId)
    .not('status', 'in', '("disqualified","lost","completed","contract_signed")')

  if (!leads || leads.length === 0) return { processed: 0, actions: [] }

  const actions: Array<{ lead_id: string; rule: string; action: string }> = []

  for (const lead of leads) {
    for (const rule of defaultRules) {
      if (rule.condition(lead)) {
        if (rule.action === 'disqualify') {
          await supabase
            .from('leads')
            .update({
              status: 'disqualified',
              disqualified_reason: rule.reason,
            })
            .eq('id', lead.id)
        } else if (rule.action === 'mark_unresponsive') {
          await supabase
            .from('leads')
            .update({ status: 'unresponsive' })
            .eq('id', lead.id)
        } else if (rule.action === 'mark_cold') {
          await supabase
            .from('leads')
            .update({ ai_qualification: 'cold' })
            .eq('id', lead.id)
        }

        // Log activity
        await supabase.from('lead_activities').insert({
          organization_id: organizationId,
          lead_id: lead.id,
          activity_type: 'disqualified',
          title: `Auto: ${rule.name}`,
          description: rule.reason,
          metadata: { rule_name: rule.name, action: rule.action },
        })

        actions.push({ lead_id: lead.id, rule: rule.name, action: rule.action })
        break // Only apply first matching rule per lead
      }
    }
  }

  return { processed: leads.length, actions }
}
