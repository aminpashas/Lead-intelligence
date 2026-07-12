import { describe, it, expect, vi } from 'vitest'
import {
  gateAnalystOutput,
  collectAllowedNumbers,
  extractNumbers,
  type AnalystInput,
} from './analyst'

// ── Fixtures ─────────────────────────────────────────────────────────────────

// A version-4/variant-1 UUID — zod's .uuid() validates version and variant
// nibbles, so an all-zeroes filler fails smartListCriteriaSchema.
const STAGE_ID = '4f2b6c1e-9c1d-4a5e-8f2a-3b6d7e8f9a0b'

function makeInput(overrides: Partial<AnalystInput> = {}): AnalystInput {
  return {
    staleDays: 7,
    stages: [
      {
        stageId: STAGE_ID,
        stageName: 'Consult Scheduled',
        kind: 'sales',
        staleReachableSms: 142,
        hotWarmReachableSms: 23,
        neverContacted: 0,
        readyToBook: 6,
        deliberatingDue: 4,
        expectedValueUsd: 52340,
      },
    ],
    openRecommendations: [
      {
        dedupe_key: `strike_hot:${STAGE_ID}`,
        kind: 'strike_hot',
        title: 'Text 23 hot & warm leads',
        lead_count: 23,
        expected_value_usd: 52340,
        priority: 72,
      },
    ],
    topObjections: [
      { objection: 'cost', count: 61 },
      { objection: 'timing', count: 18 },
    ],
    sentimentDistribution: [
      { sentiment: 'positive', count: 44 },
      { sentiment: 'negative', count: 12 },
    ],
    conversions: { converted_last_30d: 15 },
    ...overrides,
  }
}

const VALID_CRITERIA = {
  stages: [STAGE_ID],
  primary_objections: ['cost'],
  has_phone: true,
  sms_consent: true,
}

function reply(obj: unknown): string {
  return JSON.stringify(obj)
}

const resolve50 = vi.fn(async () => 50)

// ── Gate (a): strict parse + shape ───────────────────────────────────────────

describe('gateAnalystOutput — parse & shape', () => {
  it('rejects a reply with no JSON at all', async () => {
    const out = await gateAnalystOutput('I think you should call everyone.', makeInput(), resolve50)
    expect(out.reranks).toEqual([])
    expect(out.insights).toEqual([])
    expect(out.rejections).toEqual([
      expect.objectContaining({ item: 'output', reason: expect.stringContaining('parse_error') }),
    ])
  })

  it('rejects malformed JSON', async () => {
    const out = await gateAnalystOutput('{"reranks": [', makeInput(), resolve50)
    expect(out.rejections[0].reason).toContain('parse_error')
  })

  it('rejects a shape that fails the zod schema', async () => {
    const out = await gateAnalystOutput(
      reply({ reranks: [{ priority: 'high' }], insights: [] }),
      makeInput(),
      resolve50
    )
    expect(out.reranks).toEqual([])
    expect(out.rejections[0].reason).toContain('schema_error')
  })
})

// ── Gate (d): reranks — existing keys only, clamped ──────────────────────────

describe('gateAnalystOutput — reranks', () => {
  it('ignores a rerank for an unknown dedupe_key', async () => {
    const out = await gateAnalystOutput(
      reply({
        reranks: [{ dedupe_key: 'strike_hot:not-a-real-stage', priority: 90, reasoning: '' }],
        insights: [],
      }),
      makeInput(),
      resolve50
    )
    expect(out.reranks).toEqual([])
    expect(out.rejections).toEqual([
      expect.objectContaining({ item: 'rerank', reason: 'unknown_dedupe_key' }),
    ])
  })

  it('clamps priority into 0-100', async () => {
    const key = `strike_hot:${STAGE_ID}`
    const out = await gateAnalystOutput(
      reply({ reranks: [{ dedupe_key: key, priority: 250, reasoning: '' }], insights: [] }),
      makeInput(),
      resolve50
    )
    expect(out.reranks).toEqual([{ dedupe_key: key, priority: 100, reasoning: '' }])
  })

  it('accepts a rerank whose reasoning cites only input numbers', async () => {
    const key = `strike_hot:${STAGE_ID}`
    const out = await gateAnalystOutput(
      reply({
        reranks: [
          { dedupe_key: key, priority: 85, reasoning: '23 hot leads carry $52,340 of expected value.' },
        ],
        insights: [],
      }),
      makeInput(),
      resolve50
    )
    expect(out.reranks).toHaveLength(1)
    expect(out.rejections).toEqual([])
  })

  it('rejects a rerank whose reasoning invents a number', async () => {
    const key = `strike_hot:${STAGE_ID}`
    const out = await gateAnalystOutput(
      reply({
        reranks: [
          { dedupe_key: key, priority: 85, reasoning: 'These 23 leads are worth $999,999.' },
        ],
        insights: [],
      }),
      makeInput(),
      resolve50
    )
    expect(out.reranks).toEqual([])
    expect(out.rejections[0].reason).toContain('ungrounded_numbers')
    expect(out.rejections[0].reason).toContain('999999')
  })
})

// ── Gates (b) + (c): insights ────────────────────────────────────────────────

describe('gateAnalystOutput — insights', () => {
  it('accepts a valid, resolvable, grounded insight', async () => {
    const out = await gateAnalystOutput(
      reply({
        reranks: [],
        insights: [
          {
            slug: 'cost-objection-sweep',
            title: 'Cost-objection leads need a financing message',
            detail: '61 leads named cost as their main objection; 50 are reachable now.',
            segment_criteria: VALID_CRITERIA,
            kind: 'analyst_insight',
          },
        ],
      }),
      makeInput(),
      vi.fn(async () => 50)
    )
    expect(out.rejections).toEqual([])
    expect(out.insights).toEqual([
      expect.objectContaining({ slug: 'cost-objection-sweep', resolvedCount: 50 }),
    ])
  })

  it('rejects an insight whose criteria fail smartListCriteriaSchema', async () => {
    const resolver = vi.fn(async () => 50)
    const out = await gateAnalystOutput(
      reply({
        reranks: [],
        insights: [
          {
            slug: 'bad-criteria',
            title: 'Bad',
            detail: 'Bad criteria.',
            segment_criteria: { conversation_intents: ['definitely_not_an_enum'] },
            kind: 'analyst_insight',
          },
        ],
      }),
      makeInput(),
      resolver
    )
    expect(out.insights).toEqual([])
    expect(out.rejections).toEqual([
      expect.objectContaining({ item: 'insight', reason: 'invalid_segment_criteria' }),
    ])
    // Invalid criteria never reach the resolver.
    expect(resolver).not.toHaveBeenCalled()
  })

  it('rejects an insight whose segment resolves to zero leads', async () => {
    const out = await gateAnalystOutput(
      reply({
        reranks: [],
        insights: [
          {
            slug: 'empty-segment',
            title: 'Empty',
            detail: 'Nobody here.',
            segment_criteria: VALID_CRITERIA,
            kind: 'analyst_insight',
          },
        ],
      }),
      makeInput(),
      vi.fn(async () => 0)
    )
    expect(out.insights).toEqual([])
    expect(out.rejections[0].reason).toBe('segment_resolves_to_zero_leads')
  })

  it('rejects an insight whose detail cites an ungrounded number', async () => {
    const out = await gateAnalystOutput(
      reply({
        reranks: [],
        insights: [
          {
            slug: 'hallucinated-count',
            title: 'Big segment',
            detail: 'There are 8,400 leads waiting for a financing text.',
            segment_criteria: VALID_CRITERIA,
            kind: 'analyst_insight',
          },
        ],
      }),
      makeInput(),
      vi.fn(async () => 50)
    )
    expect(out.insights).toEqual([])
    expect(out.rejections[0].reason).toContain('ungrounded_numbers')
  })

  it('allows the resolved count, small numbers, and years in insight prose', async () => {
    const out = await gateAnalystOutput(
      reply({
        reranks: [],
        insights: [
          {
            slug: 'grounded',
            title: 'Grounded insight',
            detail: '50 leads (2 stages) have sat since 2026 — worth one sweep.',
            segment_criteria: VALID_CRITERIA,
            kind: 'analyst_insight',
          },
        ],
      }),
      makeInput(),
      vi.fn(async () => 50)
    )
    expect(out.rejections).toEqual([])
    expect(out.insights).toHaveLength(1)
  })

  it('caps accepted insights at 2', async () => {
    const insight = (slug: string) => ({
      slug,
      title: 'ok',
      detail: 'ok segment.',
      segment_criteria: VALID_CRITERIA,
      kind: 'analyst_insight' as const,
    })
    // zod itself rejects >2 (array max) — the whole output is refused, which is
    // the stricter, documented behavior.
    const out = await gateAnalystOutput(
      reply({ reranks: [], insights: [insight('a-a'), insight('b-b'), insight('c-c')] }),
      makeInput(),
      resolve50
    )
    expect(out.insights).toEqual([])
    expect(out.rejections[0].reason).toContain('schema_error')
  })
})

// ── Number-grounding helpers ─────────────────────────────────────────────────

describe('number grounding helpers', () => {
  it('extractNumbers parses currency, thousands separators, and decimals', () => {
    expect(extractNumbers('142 leads, $52,340 value, 3.5% lift')).toEqual([142, 52340, 3.5])
  })

  it('collectAllowedNumbers walks nested structures and adds roundings', () => {
    const allowed = collectAllowedNumbers({ a: [{ b: 52340.4 }], c: 7 })
    expect(allowed.has(52340.4)).toBe(true)
    expect(allowed.has(52340)).toBe(true)
    expect(allowed.has(7)).toBe(true)
  })
})
