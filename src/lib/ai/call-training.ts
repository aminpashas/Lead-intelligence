/**
 * Call → knowledge-base extraction.
 *
 * Turns a call transcript into org-scoped AI training material: `ai_memories`
 * (coaching instructions — how to handle objections, tone, techniques worth
 * replicating) and `ai_knowledge_articles` (reusable facts — pricing, policies,
 * procedure details staff stated on the call). Both tables already inject into
 * live setter/closer prompts via buildLiveAgentKnowledgeBlock, so anything
 * extracted here governs real patient conversations immediately.
 *
 * PHI guard: entries are org configuration shown to the AI in EVERY
 * conversation, so the prompt requires generalizing — never patient names,
 * numbers, or case-identifying details.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { AIMemoryCategory, AIKnowledgeCategory } from '@/types/database'

const EXTRACTION_MODEL = 'claude-sonnet-4-6'
const MAX_OUTPUT_TOKENS = 2000
/** Below this there isn't enough call content to learn from. */
export const MIN_TRAINING_TEXT_CHARS = 120

const MEMORY_CATEGORIES: AIMemoryCategory[] = [
  'tone_and_style',
  'product_knowledge',
  'objection_handling',
  'pricing_rules',
  'compliance_rules',
  'general',
]
const ARTICLE_CATEGORIES: AIKnowledgeCategory[] = [
  'procedures',
  'pricing',
  'faqs',
  'aftercare',
  'financing',
  'general',
]

const EXTRACTION_PROMPT = `You are distilling a phone call at a dental implant practice into training material for the practice's AI patient-communication agent. A manager reviewed this call and decided it contains information the AI should learn from.

Extract two kinds of items:

1. "memories" — coaching instructions: how the staffer handled an objection, phrasing that worked, tone guidance, a rule the AI should follow. Written as an instruction to the AI ("When a patient worries about X, do Y").
   category must be one of: tone_and_style, product_knowledge, objection_handling, pricing_rules, compliance_rules, general

2. "articles" — reusable facts stated on the call: prices quoted, financing options, procedure details, scheduling/visit policies, aftercare guidance. Written as standalone reference facts.
   category must be one of: procedures, pricing, faqs, aftercare, financing, general

Rules:
- NEVER include the patient's name, phone number, or any detail that identifies them. Generalize: "the patient" / "patients".
- Only extract what is actually in the transcript — never invent or embellish.
- Each item must be independently useful with no context from this call.
- Quality over quantity: 0-4 memories and 0-4 articles. Empty arrays are fine if the call teaches nothing reusable.
- Titles under 80 characters; content 1-4 sentences.

Output STRICT JSON only — no prose, no markdown fences:
{
  "memories": [{ "title": "...", "category": "...", "content": "..." }],
  "articles": [{ "title": "...", "category": "...", "content": "...", "tags": ["..."] }]
}`

export type ExtractedMemory = { title: string; category: AIMemoryCategory; content: string }
export type ExtractedArticle = {
  title: string
  category: AIKnowledgeCategory
  content: string
  tags: string[]
}
export type CallTrainingExtraction = { memories: ExtractedMemory[]; articles: ExtractedArticle[] }

export type ExtractionResult =
  | { status: 'ok'; extraction: CallTrainingExtraction }
  | { status: 'empty' }
  | { status: 'failed'; error: string }

/** Parse + validate the model reply; drops items with bad categories instead of failing the batch. */
export function parseExtraction(raw: string): CallTrainingExtraction | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as {
      memories?: Array<Partial<ExtractedMemory>>
      articles?: Array<Partial<ExtractedArticle>>
    }
    const memories = (Array.isArray(obj.memories) ? obj.memories : [])
      .filter(
        (m): m is ExtractedMemory =>
          typeof m.title === 'string' &&
          typeof m.content === 'string' &&
          MEMORY_CATEGORIES.includes(m.category as AIMemoryCategory)
      )
      .slice(0, 4)
    const articles = (Array.isArray(obj.articles) ? obj.articles : [])
      .filter(
        (a): a is ExtractedArticle =>
          typeof a.title === 'string' &&
          typeof a.content === 'string' &&
          ARTICLE_CATEGORIES.includes(a.category as AIKnowledgeCategory)
      )
      .map((a) => ({ ...a, tags: Array.isArray(a.tags) ? a.tags.map(String).slice(0, 6) : [] }))
      .slice(0, 4)
    return { memories, articles }
  } catch {
    return null
  }
}

/** One Claude pass over the call text. Returns a typed result; never throws. */
export async function extractCallTraining(callText: string): Promise<ExtractionResult> {
  const text = (callText || '').trim()
  if (text.length < MIN_TRAINING_TEXT_CHARS) return { status: 'empty' }
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
    const response = await anthropic.messages.create({
      model: EXTRACTION_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: EXTRACTION_PROMPT,
      messages: [{ role: 'user', content: `Call content:\n\n${text.slice(0, 60_000)}` }],
    })
    const raw = response.content
      .filter((c) => c.type === 'text')
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n')
    const extraction = parseExtraction(raw)
    if (!extraction) return { status: 'failed', error: 'unparseable_response' }
    if (extraction.memories.length === 0 && extraction.articles.length === 0) {
      return { status: 'empty' }
    }
    return { status: 'ok', extraction }
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : 'unknown' }
  }
}
