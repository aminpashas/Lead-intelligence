import { describe, it, expect } from 'vitest'
import { displaySourceLabel } from '@/lib/attribution'

describe('displaySourceLabel', () => {
  it('replaces an aggregator/call-tracking label with the resolved channel', () => {
    expect(displaySourceLabel('whatconverts', 'direct')).toBe('Direct')
    expect(displaySourceLabel('whatconverts', 'seo_organic')).toBe('Organic Search')
    expect(displaySourceLabel('gohighlevel', 'ppc_google')).toBe('Google Ads')
    expect(displaySourceLabel('GHL', 'ppc_meta')).toBe('Meta Ads')
  })

  it('is case-insensitive on the aggregator label', () => {
    expect(displaySourceLabel('WhatConverts', 'direct')).toBe('Direct')
    expect(displaySourceLabel('  gohighlevel  ', 'referral')).toBe('Referral')
  })

  it('keeps a genuine source label verbatim, ignoring the channel', () => {
    expect(displaySourceLabel('Website Contact Form', 'direct')).toBe('Website Contact Form')
    expect(displaySourceLabel('Referral Partner', 'ppc_google')).toBe('Referral Partner')
  })

  it('falls back to the raw aggregator label when no channel is known', () => {
    expect(displaySourceLabel('whatconverts', null)).toBe('whatconverts')
    expect(displaySourceLabel('whatconverts', undefined)).toBe('whatconverts')
  })

  it('returns null when nothing is known', () => {
    expect(displaySourceLabel(null, null)).toBeNull()
    expect(displaySourceLabel('', undefined)).toBeNull()
    expect(displaySourceLabel('   ', null)).toBeNull()
  })

  it('resolves an unmapped channel code to a spaced label for aggregators', () => {
    expect(displaySourceLabel('whatconverts', 'social_tiktok')).toBe('social tiktok')
  })
})
