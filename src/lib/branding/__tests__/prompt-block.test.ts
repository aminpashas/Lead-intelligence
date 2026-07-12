import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Lead } from '@/types/database'
import { resolveBrandIdentity, formatBrandIdentityBlock } from '@/lib/branding/prompt-block'

const brandingBlob = {
  brands: {
    dion_health: { name: 'Dion Health', doctorName: 'Dr. Amin Samadian', website: 'dionhealth.com' },
    tmj_sleep: { name: 'San Francisco Center for TMJ and Sleep Apnea', doctorName: 'Dr. Amin Samadian', website: 'tmjandsleepapneasanfrancisco.com' },
    sf_dentistry: { name: 'SF Dentistry', doctorName: '', website: 'sfdentistry.com' },
  },
}

/** Minimal supabase stub for getBrandingForOrg's organizations select. */
const supabaseStub = {
  from: () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: { name: 'SF Dentistry (org)', settings: { branding: brandingBlob } } }),
      }),
    }),
  }),
} as unknown as SupabaseClient

const lead = (over: Partial<Lead>): Partial<Lead> =>
  ({ tags: [], custom_fields: {}, ...over }) as unknown as Partial<Lead>

describe('resolveBrandIdentity', () => {
  it('unsignalled lead + implants fallback → Dion Health (never the TMJ brand)', async () => {
    const id = await resolveBrandIdentity(supabaseStub, 'org-1', {
      lead: lead({}),
      fallbackServiceLine: 'implants',
    })
    expect(id.practiceName).toBe('Dion Health')
    expect(id.doctorName).toBe('Dr. Amin Samadian')
    expect(id.forbiddenNames).toContain('San Francisco Center for TMJ and Sleep Apnea')
    expect(id.forbiddenNames).toContain('SF Dentistry')
    expect(id.forbiddenNames).not.toContain('Dion Health')
  })

  it('explicitly-signalled TMJ lead still gets the TMJ brand', async () => {
    const id = await resolveBrandIdentity(supabaseStub, 'org-1', {
      lead: lead({ tags: ['src:tmj'] }),
      fallbackServiceLine: 'implants',
    })
    expect(id.practiceName).toBe('San Francisco Center for TMJ and Sleep Apnea')
    expect(id.forbiddenNames).toContain('Dion Health')
  })

  it('explicit serviceLine wins over lead signals and fallback', async () => {
    const id = await resolveBrandIdentity(supabaseStub, 'org-1', {
      lead: lead({ tags: ['src:tmj'] }),
      serviceLine: 'implants',
    })
    expect(id.practiceName).toBe('Dion Health')
  })
})

describe('formatBrandIdentityBlock', () => {
  it('names the brand, allows the doctor, and forbids sibling brands', async () => {
    const id = await resolveBrandIdentity(supabaseStub, 'org-1', {
      lead: lead({}),
      fallbackServiceLine: 'implants',
    })
    const block = formatBrandIdentityBlock(id)
    expect(block).toContain('You represent Dion Health')
    expect(block).toContain('Dr. Amin Samadian')
    expect(block).toContain('NEVER use these sibling brand names')
    expect(block).toContain('San Francisco Center for TMJ and Sleep Apnea')
  })

  it('forbids naming a doctor when the brand has none configured', () => {
    const block = formatBrandIdentityBlock({
      practiceName: 'SF Dentistry',
      doctorName: null,
      website: null,
      logistics: { addressText: '', drivingText: '', parkingText: '', transitText: '', whatToExpectText: '' },
      forbiddenNames: ['Dion Health'],
    })
    expect(block).toContain('Do not name a specific doctor')
  })
})
