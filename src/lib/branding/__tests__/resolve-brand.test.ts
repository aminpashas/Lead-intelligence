import { describe, it, expect } from 'vitest'
import type { Lead } from '@/types/database'
import { parseBranding } from '@/lib/branding/schema'
import { resolveBrand, resolveBrandServiceLine, resolveBrandForContext } from '@/lib/branding/resolve-brand'

const branding = parseBranding({
  brands: {
    dion_health: { name: 'Dion Health', doctorName: 'Dr. Amin Samadian', website: 'dionhealth.com' },
    tmj_sleep: { name: 'San Francisco Center for TMJ and Sleep Apnea', doctorName: 'Dr. Amin Samadian', website: 'tmjandsleepapneasanfrancisco.com' },
    sf_dentistry: { name: 'SF Dentistry', doctorName: '', website: 'sfdentistry.com' },
  },
  logistics: { addressText: '123 Sutter St', parkingText: 'Garage validated', transitText: 'BART: Montgomery' },
})

const lead = (over: Partial<Lead>): Lead => ({ tags: [], custom_fields: {} , ...over } as unknown as Lead)

describe('resolveBrandServiceLine', () => {
  it('prefers an explicit campaign/context service line', () => {
    expect(resolveBrandServiceLine({ serviceLine: 'tmj' })).toBe('tmj')
  })
  it('detects tmj from the real intake tag src:tmj', () => {
    expect(resolveBrandServiceLine({ lead: lead({ tags: ['src:tmj'] }) })).toBe('tmj')
  })
  it('detects implants only from an explicit signal, never as a residual', () => {
    expect(resolveBrandServiceLine({ lead: lead({ custom_fields: { treatment_interest: 'implant' } }) })).toBe('implants')
    expect(resolveBrandServiceLine({ lead: lead({}) })).toBeNull()
  })
  it('prioritises the niche medical lines over implants on multi-match', () => {
    expect(resolveBrandServiceLine({ lead: lead({ tags: ['src:tmj', 'implants'] }) })).toBe('tmj')
  })
})

describe('resolveBrand', () => {
  it('maps implants → Dion Health with the doctor named', () => {
    const r = resolveBrand(branding, 'implants', 'Fallback Org')
    expect(r.practiceName).toBe('Dion Health')
    expect(r.doctorName).toBe('Dr. Amin Samadian')
    expect(r.website).toBe('dionhealth.com')
  })
  it('maps tmj/sleep_apnea → the TMJ & Sleep center', () => {
    expect(resolveBrand(branding, 'tmj', 'x').practiceName).toBe('San Francisco Center for TMJ and Sleep Apnea')
    expect(resolveBrand(branding, 'sleep_apnea', 'x').practiceName).toBe('San Francisco Center for TMJ and Sleep Apnea')
  })
  it('unknown / null service line → SF Dentistry, no doctor named', () => {
    const r = resolveBrand(branding, null, 'x')
    expect(r.practiceName).toBe('SF Dentistry')
    expect(r.doctorName).toBeNull()
  })
  it('falls back to the org name when the brand slot has no name', () => {
    const empty = parseBranding({})
    expect(resolveBrand(empty, 'implants', 'Acme Dental').practiceName).toBe('Acme Dental')
  })
  it('always carries the shared logistics block', () => {
    expect(resolveBrand(branding, 'tmj', 'x').logistics.parkingText).toBe('Garage validated')
  })
})

describe('resolveBrandForContext', () => {
  it('composes lead detection + brand resolution', () => {
    const r = resolveBrandForContext(branding, 'Fallback', { lead: lead({ tags: ['src:tmj'] }) })
    expect(r.practiceName).toBe('San Francisco Center for TMJ and Sleep Apnea')
  })
  it('an unsignalled lead resolves to the default brand', () => {
    expect(resolveBrandForContext(branding, 'Fallback', { lead: lead({}) }).practiceName).toBe('SF Dentistry')
  })
})
