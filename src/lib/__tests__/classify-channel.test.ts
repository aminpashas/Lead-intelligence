import { describe, it, expect } from 'vitest'
import { classifyChannelFromUtm, FALLBACK_CONFIDENCE } from '@/lib/attribution/classify-channel'

// Every case below is drawn from real null-channel leads observed in prod
// (the WhatConverts/GHL source labels DGS's resolver failed to classify).
const channelOf = (s: Parameters<typeof classifyChannelFromUtm>[0]) =>
  classifyChannelFromUtm(s)?.channel ?? null

describe('classifyChannelFromUtm', () => {
  it('recovers a paid Google lead from gclid alone (DGS miss)', () => {
    // Real row: utm_source=google, no medium, campaign=all-on-4-sf, gclid set.
    expect(channelOf({ utm_source: 'google', utm_campaign: 'all-on-4-sf', gclid: 'Cj0abc' }))
      .toBe('ppc_google')
  })

  it('classifies google + cpc as paid search', () => {
    expect(channelOf({ utm_source: 'google', utm_medium: 'cpc', utm_campaign: '20398498273' }))
      .toBe('ppc_google')
  })

  it('classifies facebook + paid as paid social', () => {
    expect(channelOf({ utm_source: 'facebook', utm_medium: 'paid' })).toBe('ppc_meta')
  })

  it('does NOT call a bare facebook source paid — organic social, not an ad', () => {
    // 199 real rows: utm_source=facebook, no medium. Must not inflate ppc_meta.
    expect(channelOf({ utm_source: 'facebook' })).toBe('social_fb')
  })

  it('does NOT call a bare google source paid — organic search', () => {
    // 43 real rows: utm_source=google, no medium, no gclid.
    expect(channelOf({ utm_source: 'google' })).toBe('seo_organic')
  })

  it('maps "SEO - SF" / "SEO - Orinda" labels to organic search', () => {
    expect(channelOf({ utm_source: 'SEO - SF', utm_medium: '(none)' })).toBe('seo_organic')
    expect(channelOf({ utm_source: 'SEO - Orinda' })).toBe('seo_organic')
  })

  it('maps GMB labels to Google Business Profile', () => {
    expect(channelOf({ utm_source: 'GMBlisting' })).toBe('seo_gmb')
    expect(channelOf({ utm_source: 'GMBlisting', utm_medium: 'organic', utm_campaign: 'gmb' })).toBe('seo_gmb')
    expect(channelOf({ utm_source: 'TMJ GMB Number' })).toBe('seo_gmb')
  })

  it('maps AI assistants to seo_ai', () => {
    expect(channelOf({ utm_source: 'chatgpt.com' })).toBe('seo_ai')
  })

  it('treats non-google search engines as organic', () => {
    expect(channelOf({ utm_source: 'bing' })).toBe('seo_organic')
    expect(channelOf({ utm_source: 'duckduckgo.com' })).toBe('seo_organic')
    expect(channelOf({ utm_source: 'yahoo' })).toBe('seo_organic')
  })

  it('classifies organic medium regardless of source', () => {
    expect(channelOf({ utm_source: 'newsletter', utm_medium: 'organic' })).toBe('seo_organic')
  })

  it('maps yelp / other social sources', () => {
    expect(channelOf({ utm_source: 'yelp.com' })).toBe('social_yelp')
    expect(channelOf({ utm_source: 'm.facebook.com' })).toBe('social_fb')
  })

  it('treats a bare external domain as referral', () => {
    expect(channelOf({ utm_source: 'drmaddahi.com', utm_medium: 'referral' })).toBe('referral')
    expect(channelOf({ utm_source: 'sfdentistry.com' })).toBe('referral')
  })

  it('resolves explicit and empty signals to direct', () => {
    expect(channelOf({ utm_source: '(direct)', utm_medium: '(none)' })).toBe('direct')
    expect(channelOf({})).toBe('direct')
    expect(channelOf({ utm_source: '(not set)', utm_medium: '(not set)' })).toBe('direct')
  })

  it('leaves genuinely ambiguous call-tracking labels unresolved (null)', () => {
    // Better a null bucket than a wrong channel: these carry no channel signal.
    expect(classifyChannelFromUtm({ utm_source: 'Mother Line Tracking Number' })).toBeNull()
    expect(classifyChannelFromUtm({ utm_source: 'TMJ Website Tracking Number' })).toBeNull()
    expect(classifyChannelFromUtm({ utm_source: 'New Mover Mailers' })).toBeNull()
  })

  it('stamps a low confidence that DGS can always override', () => {
    const r = classifyChannelFromUtm({ utm_source: 'google', utm_medium: 'cpc' })
    expect(r?.confidence).toBe(FALLBACK_CONFIDENCE)
    expect(FALLBACK_CONFIDENCE).toBeLessThan(0.85)
  })
})
