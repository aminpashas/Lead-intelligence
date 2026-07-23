import { describe, it, expect } from 'vitest'
import type { Lead } from '@/types/database'
import { parseBranding } from '@/lib/branding/schema'
import { buildTemplateContext, processTemplate } from '../template'

const branding = parseBranding({
  brands: {
    dion_health: { name: 'Dion Health San Francisco', doctorName: 'Dr. Amin Samadian', website: 'dionhealth.com' },
    tmj_sleep: { name: 'San Francisco Center for TMJ and Sleep Apnea', doctorName: 'Dr. Amin Samadian', website: 'tmjandsleepapneasanfrancisco.com' },
    sf_dentistry: { name: 'SF Dentistry', doctorName: '', website: 'sfdentistry.com' },
  },
})

const lead = (over: Partial<Lead>): Partial<Lead> => ({ tags: [], custom_fields: {}, ...over })

describe('buildTemplateContext branding', () => {
  it('resolves {{practice_name}} to the implants DBA for an implant lead', () => {
    const ctx = buildTemplateContext(lead({ custom_fields: { treatment_interest: 'implant' } }), 'SF Dentistry', 'org-1', branding)
    expect(ctx.practice_name).toBe('Dion Health San Francisco')
    expect(processTemplate('Hi {{first_name}} — {{practice_name}}', ctx)).toBe('Hi there — Dion Health San Francisco')
  })

  it('resolves {{practice_name}} to the TMJ center for a TMJ-tagged lead', () => {
    const ctx = buildTemplateContext(lead({ tags: ['src:tmj'] }), 'SF Dentistry', 'org-1', branding)
    expect(ctx.practice_name).toBe('San Francisco Center for TMJ and Sleep Apnea')
  })

  it('falls back to the default (house) brand for a signal-less lead', () => {
    // No niche signal → resolver returns null service line → defaultBrand (SF Dentistry).
    const ctx = buildTemplateContext(lead({}), 'SF Dentistry', 'org-1', branding)
    expect(ctx.practice_name).toBe('SF Dentistry')
  })

  it('keeps the legacy raw-org-name behaviour when no branding is passed', () => {
    const ctx = buildTemplateContext(lead({ tags: ['src:tmj'] }), 'Some Org LLC', 'org-1')
    expect(ctx.practice_name).toBe('Some Org LLC')
  })
})
