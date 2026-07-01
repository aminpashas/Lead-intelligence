import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgencyAiRule } from '@/types/database'

type RuleForBlock = Pick<AgencyAiRule, 'title' | 'category' | 'content'>

/** Pure formatter: renders enabled rules into a system-prompt block. Empty-safe. */
export function formatRulesBlock(rules: RuleForBlock[]): string {
  if (rules.length === 0) return ''
  const body = rules.map((r) => `### ${r.title} [${r.category}]\n${r.content}`).join('\n\n')
  return `## Agency Rules\nThese rules apply to EVERY practice and override softer guidance below when they conflict:\n\n${body}`
}

/** Derive DB fields from a raw SMS rule text. First ~8 words → title. */
export function deriveRuleFields(text: string): {
  title: string
  content: string
  category: string
  priority: number
} {
  const content = text.trim()
  const title = content.split(/\s+/).slice(0, 8).join(' ').slice(0, 60)
  return { title, content, category: 'general', priority: 100 }
}

/**
 * Assemble the agency-wide rules block for the LIVE setter/closer agents.
 * Reads with whatever client is passed (service role in the webhook path, so
 * RLS is bypassed). Returns '' when there are no enabled rules.
 */
export async function buildAgencyRulesBlock(supabase: SupabaseClient): Promise<string> {
  const { data } = await supabase
    .from('agency_ai_rules')
    .select('title, category, content')
    .eq('is_enabled', true)
    .order('priority', { ascending: false })
  return formatRulesBlock((data as RuleForBlock[]) || [])
}

/** Persist a new agency rule authored over SMS. */
export async function createAgencyRule(
  supabase: SupabaseClient,
  params: { text: string; createdBy: string }
): Promise<void> {
  const fields = deriveRuleFields(params.text)
  await supabase.from('agency_ai_rules').insert({
    ...fields,
    source: 'sms_training',
    created_by: params.createdBy,
  })
}
