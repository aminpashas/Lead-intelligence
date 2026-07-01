import { describe, it, expect } from 'vitest'
import { deriveKeywordFromUtm } from '@/lib/enrichment/google-ads-keyword'
import { googleAdsKeywordConfidence } from '@/lib/enrichment/google-ads-keyword'

describe('deriveKeywordFromUtm', () => {
  it('maps utm_term to the search keyword', () => {
    expect(deriveKeywordFromUtm({ term: 'dental implants near me', campaign: 'Implants-Search', content: 'ad-2' })).toEqual({
      keyword: 'dental implants near me',
      campaign_name: 'Implants-Search',
      ad_group_name: 'ad-2',
      match_type: null,
      device: null,
    })
  })

  it('works with only a campaign (no keyword)', () => {
    expect(deriveKeywordFromUtm({ campaign: 'Brand' })).toEqual({
      keyword: null,
      campaign_name: 'Brand',
      ad_group_name: null,
      match_type: null,
      device: null,
    })
  })

  it('returns null when there is no usable UTM signal', () => {
    expect(deriveKeywordFromUtm(null)).toBeNull()
    expect(deriveKeywordFromUtm(undefined)).toBeNull()
    expect(deriveKeywordFromUtm({})).toBeNull()
    expect(deriveKeywordFromUtm({ term: '  ', campaign: '', content: null })).toBeNull()
  })

  it('confidence reflects the derived signal strength', () => {
    expect(googleAdsKeywordConfidence(deriveKeywordFromUtm({ term: 'implants' }))).toBe(1.0)
    expect(googleAdsKeywordConfidence(deriveKeywordFromUtm({ campaign: 'Brand' }))).toBe(0.6)
    expect(googleAdsKeywordConfidence(deriveKeywordFromUtm(null))).toBe(0)
  })
})
