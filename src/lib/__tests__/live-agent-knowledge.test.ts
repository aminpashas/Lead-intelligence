import { describe, it, expect } from 'vitest'
import { buildTrainingSystemPrompt, formatAgencyPersonaBlock } from '@/lib/ai/training-context'
import type { AIMemory, AIKnowledgeArticle } from '@/types/database'

const memory = (over: Partial<AIMemory> = {}): AIMemory =>
  ({ title: 'Tone', category: 'style', content: 'Be warm and concise.', ...over }) as AIMemory
const article = (over: Partial<AIKnowledgeArticle> = {}): AIKnowledgeArticle =>
  ({ title: 'All-on-4 FAQ', content: 'Healing takes ~4 months.', ...over }) as AIKnowledgeArticle

// buildLiveAgentKnowledgeBlock (used by the live setter/closer agents) is built
// on top of buildTrainingSystemPrompt with an empty base — these tests pin that
// contract so the injected block is well-formed and empty-safe.
describe('buildTrainingSystemPrompt (live-agent injection contract)', () => {
  it('returns the base unchanged when there is no trained content', () => {
    expect(buildTrainingSystemPrompt('', [], [])).toBe('')
    expect(buildTrainingSystemPrompt('BASE', [], [])).toBe('BASE')
  })

  it('with an empty base, yields just the trained sections (what the live agents append)', () => {
    const block = buildTrainingSystemPrompt('', [memory()], [article()]).trimStart()
    expect(block.startsWith('## Training Instructions')).toBe(true)
    expect(block).toContain('Be warm and concise.')
    expect(block).toContain('## Knowledge Base Reference')
    expect(block).toContain('Healing takes ~4 months.')
  })

  it('includes only the memory section when there is no knowledge', () => {
    const block = buildTrainingSystemPrompt('', [memory()], []).trimStart()
    expect(block).toContain('## Training Instructions')
    expect(block).not.toContain('## Knowledge Base Reference')
  })

  it('appends after the base prompt, preserving it', () => {
    const out = buildTrainingSystemPrompt('SYSTEM PROMPT', [memory()], [])
    expect(out.startsWith('SYSTEM PROMPT')).toBe(true)
    expect(out).toContain('## Training Instructions')
  })
})

describe('formatAgencyPersonaBlock (agency config → live agents)', () => {
  it('renders systemPromptSuffix and tone', () => {
    const block = formatAgencyPersonaBlock({ name: 'Aria', tone: 'warm', systemPromptSuffix: 'Always mention our lifetime warranty.' })
    expect(block).toContain('## Agency Voice & Persona')
    expect(block).toContain('Always mention our lifetime warranty.')
    expect(block).toContain('warm tone')
  })

  it('returns empty when nothing meaningful is set', () => {
    expect(formatAgencyPersonaBlock(null)).toBe('')
    expect(formatAgencyPersonaBlock(undefined)).toBe('')
    expect(formatAgencyPersonaBlock({ name: 'Aria' })).toBe('')
    expect(formatAgencyPersonaBlock({ tone: '   ', systemPromptSuffix: '  ' })).toBe('')
  })
})
