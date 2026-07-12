import { describe, it, expect } from 'vitest'
import { parseExtraction } from '../call-training'

describe('parseExtraction', () => {
  it('parses a well-formed reply', () => {
    const raw = JSON.stringify({
      memories: [
        { title: 'Cost objection', category: 'objection_handling', content: 'Lead with monthly payment framing.' },
      ],
      articles: [
        { title: 'All-on-4 price', category: 'pricing', content: 'Full arch starts at $24,000.', tags: ['pricing'] },
      ],
    })
    const out = parseExtraction(raw)
    expect(out).not.toBeNull()
    expect(out!.memories).toHaveLength(1)
    expect(out!.articles).toHaveLength(1)
    expect(out!.articles[0].tags).toEqual(['pricing'])
  })

  it('strips surrounding prose / markdown fences', () => {
    const raw = 'Here you go:\n```json\n{"memories":[],"articles":[{"title":"T","category":"faqs","content":"C"}]}\n```'
    const out = parseExtraction(raw)
    expect(out).not.toBeNull()
    expect(out!.articles).toHaveLength(1)
    // Missing tags array normalizes to []
    expect(out!.articles[0].tags).toEqual([])
  })

  it('drops items with invalid categories instead of failing the batch', () => {
    const raw = JSON.stringify({
      memories: [
        { title: 'Good', category: 'tone_and_style', content: 'x' },
        { title: 'Bad', category: 'not_a_category', content: 'x' },
      ],
      articles: [{ title: 'Bad', category: 'bogus', content: 'x' }],
    })
    const out = parseExtraction(raw)
    expect(out!.memories).toHaveLength(1)
    expect(out!.memories[0].title).toBe('Good')
    expect(out!.articles).toHaveLength(0)
  })

  it('caps items at 4 per kind', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      title: `M${i}`,
      category: 'general',
      content: 'x',
    }))
    const out = parseExtraction(JSON.stringify({ memories: many, articles: many }))
    expect(out!.memories).toHaveLength(4)
    expect(out!.articles).toHaveLength(4)
  })

  it('returns null on unparseable output', () => {
    expect(parseExtraction('no json here')).toBeNull()
    expect(parseExtraction('{broken')).toBeNull()
  })
})
