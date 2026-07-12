/**
 * FCRA guardrail (Workstream B2).
 *
 * Experian ConsumerView data is FCRA-EXEMPT marketing data ONLY while it is
 * used for marketing (segmentation, prioritization, personalization). If it
 * flows into a credit/financing ELIGIBILITY determination it becomes a
 * consumer report under 15 U.S.C. § 1681a(d) and its use is illegal without
 * FCRA compliance (permissible purpose, adverse-action notices, etc.).
 *
 * These tests statically enforce that the widened marketing attribute surface
 * (lead_enrichment.enrichment_attributes and its `experian.*` keys) never
 * leaks into the financing/credit code paths.
 *
 * KNOWN, DELIBERATELY SCOPED EXCEPTION: credit-prequal.ts has a pre-existing
 * direct import of enrichWithExperian (Layer-1 credit-tier ESTIMATION used to
 * pick which soft-prequal lenders to surface — it predates this workstream and
 * that file is read-only for B2). The guardrail therefore pins the boundary
 * where it can: (a) the AI financial-qualifier must not touch Experian at all,
 * and (b) NEITHER financing file may read enrichment_attributes or any
 * `experian.*` namespaced key or the raw `.attributes` payload.
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
  it('does not reference enrichment_attributes or experian.* namespaced keys', () => {
    expect(creditPrequalSrc).not.toContain('enrichment_attributes')
    expect(creditPrequalSrc).not.toMatch(EXPERIAN_KEY_REF)
  })

  it('does not consume the raw widened attributes payload from Experian results', () => {
    // The full raw vars payload lives on ExperianConsumerResult.attributes —
    // financing code must never read it (only the typed, deliberately
    // constrained fields it already used before B2).
    expect(creditPrequalSrc).not.toMatch(/\.attributes\b/)
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
