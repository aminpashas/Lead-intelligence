import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIMemory, AIKnowledgeArticle } from '@/types/database'

// ── Mode Base Prompts ─────────────────────────────────────

export const PLAYGROUND_MODES = {
  general: {
    label: 'General Assistant',
    prompt: `You are an AI assistant for an All-on-4 dental implant practice. You help the practice staff with patient communication, scheduling, and general questions about dental implant procedures. Be professional, knowledgeable, and empathetic.`,
  },
  lead_engagement: {
    label: 'Lead Engagement',
    prompt: `You are an AI treatment coordinator for an All-on-4 dental implant practice. You are having a conversation with a potential patient who has expressed interest in dental implants. Your goal is to educate them, build trust, address concerns, and guide them toward scheduling a consultation. Be warm, professional, and never pushy.`,
  },
  objection_handling: {
    label: 'Objection Handling',
    prompt: `You are an AI treatment coordinator specializing in handling patient objections about All-on-4 dental implants. Common objections include cost concerns, fear of pain, recovery time, and dental anxiety. Address each concern with empathy, facts, and reassurance. Never dismiss concerns — validate them first, then provide information.`,
  },
  appointment_scheduling: {
    label: 'Appointment Scheduling',
    prompt: `You are an AI scheduling assistant for an All-on-4 dental implant practice. Your goal is to help patients schedule consultations. Be friendly, efficient, and flexible. Offer multiple time options, explain what to expect at the consultation, and address any last-minute hesitations.`,
  },
  education: {
    label: 'Patient Education',
    prompt: `You are an AI educator for an All-on-4 dental implant practice. You explain the All-on-4 procedure, benefits, recovery process, candidacy requirements, and compare it to alternatives (traditional dentures, individual implants, bridges). Use clear, non-technical language. Be thorough but not overwhelming.`,
  },
  follow_up: {
    label: 'Follow-Up',
    prompt: `You are an AI follow-up specialist for an All-on-4 dental implant practice. You craft personalized follow-up messages for patients who have shown interest but haven't yet scheduled. Reference their specific situation, acknowledge the decision is significant, and gently re-engage without being pushy.`,
  },
} as const

export type PlaygroundMode = keyof typeof PLAYGROUND_MODES

// ── Data Fetching ─────────────────────────────────────────

export async function getActiveMemories(
  supabase: SupabaseClient,
  orgId: string
): Promise<AIMemory[]> {
  const { data, error } = await supabase
    .from('ai_memories')
    .select('*')
    .eq('organization_id', orgId)
    .eq('is_enabled', true)
    .order('priority', { ascending: false })

  if (error) {
    console.error('Failed to fetch AI memories:', error)
    return []
  }

  return (data || []) as AIMemory[]
}

export async function getRelevantKnowledge(
  supabase: SupabaseClient,
  orgId: string,
  query: string
): Promise<AIKnowledgeArticle[]> {
  // Extract meaningful search terms from the query
  const searchTerms = query
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 8)
    .join(' & ')

  if (!searchTerms) {
    // If no meaningful terms, return top enabled articles
    const { data } = await supabase
      .from('ai_knowledge_articles')
      .select('*')
      .eq('organization_id', orgId)
      .eq('is_enabled', true)
      .order('created_at', { ascending: false })
      .limit(3)

    return (data || []) as AIKnowledgeArticle[]
  }

  // Full-text search
  const { data, error } = await supabase
    .from('ai_knowledge_articles')
    .select('*')
    .eq('organization_id', orgId)
    .eq('is_enabled', true)
    .textSearch('title', searchTerms, { type: 'websearch' })
    .limit(5)

  if (error || !data || data.length === 0) {
    // Fallback: try content search or return recent articles
    const { data: fallback } = await supabase
      .from('ai_knowledge_articles')
      .select('*')
      .eq('organization_id', orgId)
      .eq('is_enabled', true)
      .order('created_at', { ascending: false })
      .limit(3)

    return (fallback || []) as AIKnowledgeArticle[]
  }

  return data as AIKnowledgeArticle[]
}

// ── System Prompt Builder ─────────────────────────────────

export function buildTrainingSystemPrompt(
  basePrompt: string,
  memories: AIMemory[],
  articles: AIKnowledgeArticle[]
): string {
  let systemPrompt = basePrompt

  if (memories.length > 0) {
    const memorySection = memories
      .map((m) => `### ${m.title} [${m.category}]\n${m.content}`)
      .join('\n\n')

    systemPrompt += `\n\n## Training Instructions\nFollow these guidelines when responding:\n\n${memorySection}`
  }

  if (articles.length > 0) {
    const knowledgeSection = articles
      .map((a) => `### ${a.title}\n${a.content}`)
      .join('\n\n')

    systemPrompt += `\n\n## Knowledge Base Reference\nUse the following knowledge when relevant to the conversation:\n\n${knowledgeSection}`
  }

  return systemPrompt
}

/**
 * Assemble the org's active memories + query-relevant knowledge into a
 * system-prompt block for the LIVE setter/closer agents.
 *
 * Previously this org-authored guidance only reached the training playground
 * and roleplay simulator — the agents messaging real patients never saw it, so
 * "train your AI" was cosmetic. This closes that gap: the same memories and
 * knowledge base now govern production conversations. Returns '' when the org
 * has configured neither (so callers can append unconditionally).
 *
 * The `query` (typically the latest inbound patient message) is used only for
 * server-side full-text ranking of knowledge articles — it is not persisted.
 * Memories/knowledge are org configuration, not patient PHI.
 */
export async function buildLiveAgentKnowledgeBlock(
  supabase: SupabaseClient,
  orgId: string,
  query: string
): Promise<string> {
  const [memories, articles] = await Promise.all([
    getActiveMemories(supabase, orgId),
    getRelevantKnowledge(supabase, orgId, query || ''),
  ])
  if (memories.length === 0 && articles.length === 0) return ''
  // Reuse the training formatter with an empty base to get just the sections.
  return buildTrainingSystemPrompt('', memories, articles).trimStart()
}

/**
 * Format the agency-wide AI persona (name / tone / systemPromptSuffix, set on
 * the agency AI-config screen) into a system-prompt block. Pure + testable.
 * Returns '' when nothing meaningful is configured.
 */
export function formatAgencyPersonaBlock(
  value: { name?: string; tone?: string; systemPromptSuffix?: string } | null | undefined
): string {
  if (!value) return ''
  const parts: string[] = []
  if (value.systemPromptSuffix && value.systemPromptSuffix.trim()) parts.push(value.systemPromptSuffix.trim())
  if (value.tone && value.tone.trim()) parts.push(`Maintain a ${value.tone.trim()} tone throughout.`)
  if (parts.length === 0) return ''
  return `## Agency Voice & Persona\n${parts.join('\n')}`
}

/**
 * Load the agency-wide persona and format it for the LIVE agents. The agency
 * AI-config screen told operators this "applies to all practices" and "takes
 * effect on every AI conversation" — but no live agent ever read it. This makes
 * that claim true. `agency_settings` is a global key-value table.
 */
export async function buildAgencyPersonaBlock(supabase: SupabaseClient): Promise<string> {
  const { data } = await supabase
    .from('agency_settings')
    .select('value')
    .eq('key', 'ai_persona')
    .maybeSingle<{ value: { name?: string; tone?: string; systemPromptSuffix?: string } | null }>()
  return formatAgencyPersonaBlock(data?.value)
}
