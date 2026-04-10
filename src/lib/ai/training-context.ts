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
