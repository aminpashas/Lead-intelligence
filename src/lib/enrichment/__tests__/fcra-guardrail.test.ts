/**
 * FCRA guardrail (Workstream B2, hardened 2026-07-11).
 *
 * Experian ConsumerView data is FCRA-EXEMPT marketing data ONLY while it is
 * used for marketing (segmentation, prioritization, personalization). If it
 * flows into a credit/financing ELIGIBILITY determination it becomes a
 * consumer report under 15 U.S.C. § 1681a(d) and its use is illegal without
 * FCRA compliance (permissible purpose, adverse-action notices, etc.).
 *
 * These tests statically enforce the boundary:
 *  1. Neither the AI financial-qualifier nor credit-prequal may touch
 *     Experian data in ANY form (import, enrichment_attributes, experian.*
 *     keys, raw attributes payload). The former Layer-1 exception (a direct
 *     enrichWithExperian import in credit-prequal.ts) was removed 2026-07-11
 *     — it is now a hard ban, not a scoped carve-out.
 *  2. The financing apply route must run TIER-NEUTRAL: no estimated credit
 *     tier read from leads/enrichment data may select, order, or exclude
 *     lenders on a real application. (leads.credit_tier was never written,
 *     but the read path existed — it is now severed and must stay severed.)
 *  3. The staff enrichment endpoint must not return credit_prequal payloads
 *     (pre_qualified flags / recommended lender / credit tier), so estimated
 *     credit data cannot leak into human or AI eligibility decisions.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EXPERIAN_DATA_USAGE } from '../experian-consumer'

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const financialQualifierSrc = read('../../ai/financial-qualifier.ts')
const creditPrequalSrc = read('../credit-prequal.ts')
const experianSrc = read('../experian-consumer.ts')
const financingApplySrc = read('../../../app/api/financing/apply/route.ts')
const leadEnrichRouteSrc = read('../../../app/api/leads/[id]/enrich/route.ts')

/** Matches string/property references to namespaced experian attribute keys, e.g. 'experian.mosaic_group'. */
const EXPERIAN_KEY_REF = /['"`]experian\.[a-z0-9_]*/i

describe('FCRA guardrail: financial-qualifier (credit eligibility AI)', () => {
  it('does not import from experian-consumer', () => {
    expect(financialQualifierSrc).not.toMatch(/from\s+['"][^'"]*experian-consumer['"]/)
    expect(financialQualifierSrc).not.toMatch(/require\(\s*['"][^'"]*experian-consumer['"]/)
  })

  it('does not reference enrichment_attributes or experian.* keys', () => {
    expect(financialQualifierSrc).not.toContain('enrichment_attributes')
    expect(financialQualifierSrc).not.toMatch(EXPERIAN_KEY_REF)
  })
})

describe('FCRA guardrail: credit-prequal (lender soft pre-qualification)', () => {
  it('does not import from experian-consumer (former Layer-1 exception, now banned)', () => {
    expect(creditPrequalSrc).not.toMatch(/from\s+['"][^'"]*experian-consumer['"]/)
    expect(creditPrequalSrc).not.toMatch(/require\(\s*['"][^'"]*experian-consumer['"]/)
    expect(creditPrequalSrc).not.toContain('enrichWithExperian')
    expect(creditPrequalSrc).not.toContain('experian_consumerview')
  })

  it('does not reference enrichment_attributes or experian.* namespaced keys', () => {
    expect(creditPrequalSrc).not.toContain('enrichment_attributes')
    expect(creditPrequalSrc).not.toMatch(EXPERIAN_KEY_REF)
  })

  it('does not consume the raw widened attributes payload from Experian results', () => {
    // The full raw vars payload lives on ExperianConsumerResult.attributes —
    // financing code must never read it.
    expect(creditPrequalSrc).not.toMatch(/\.attributes\b/)
  })
})

describe('FCRA guardrail: financing apply route (real applications, tier-neutral)', () => {
  it('does not read an estimated credit tier from leads/enrichment data', () => {
    // The snake_case column / data key. The PascalCase `CreditTier` TYPE and
    // the NEUTRAL_TIER constant are the only allowed tier references.
    expect(financingApplySrc).not.toContain("credit_tier")
    expect(financingApplySrc).not.toMatch(/\bcreditTier\b/)
    expect(financingApplySrc).not.toContain('lead_enrichment')
  })

  it('builds the waterfall with the neutral tier constant only', () => {
    const calls = financingApplySrc.match(/buildOptimalWaterfallOrder\([^)]*\)/g) ?? []
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call).toContain('NEUTRAL_TIER')
    }
    expect(financingApplySrc).toMatch(/NEUTRAL_TIER:\s*CreditTier\s*=\s*'unknown'/)
  })
})

describe('FCRA guardrail: lead enrichment endpoint (no credit_prequal leakage)', () => {
  it('excludes credit_prequal rows from the staff-facing response', () => {
    expect(leadEnrichRouteSrc).toMatch(/\.neq\(\s*'enrichment_type'\s*,\s*'credit_prequal'\s*\)/)
  })
})

describe('FCRA guardrail: experian-consumer data classification', () => {
  it('exports EXPERIAN_DATA_USAGE tagged as marketing', () => {
    expect(EXPERIAN_DATA_USAGE).toBe('marketing')
  })

  it('carries the FCRA restriction in the module source', () => {
    expect(experianSrc).toContain('FCRA')
    expect(experianSrc).toContain("EXPERIAN_DATA_USAGE = 'marketing' as const")
  })
})
