import { describe, it, expect } from 'vitest'
import {
  classifyLeadServiceLines,
  serviceLineOrFilter,
  serviceLineFromPipelineName,
  serviceLineFromIntakeSignals,
} from '@/lib/leads/service-line'
import type { Lead } from '@/types/database'

// Minimal Lead fixture — only the fields the classifier reads matter.
const lead = (o: Partial<Lead>): Lead =>
  ({
    tags: [],
    custom_fields: {},
    utm_campaign: null,
    utm_source: null,
    campaign_attribution: null,
    ...o,
  }) as Lead

describe('classifyLeadServiceLines — Implants is the residual default', () => {
  it('classifies a lead with NO treatment signal as implants (the AOX/Full-Arch book)', () => {
    // The ~48k historical GHL import lost its pipeline attribution on reconcile,
    // so these carry nothing. For an implant-focused practice they are implants.
    expect(classifyLeadServiceLines(lead({}))).toEqual(['implants'])
  })

  it('classifies an explicit implant signal as implants', () => {
    expect(
      classifyLeadServiceLines(lead({ custom_fields: { treatment_interest: 'implant' } }))
    ).toEqual(['implants'])
    expect(classifyLeadServiceLines(lead({ tags: ['full-arch-cold'] }))).toEqual(['implants'])
  })

  it('classifies a niche lead as ONLY that niche, not implants', () => {
    expect(classifyLeadServiceLines(lead({ tags: ['src:tmj'] }))).toEqual(['tmj'])
    expect(
      classifyLeadServiceLines(lead({ custom_fields: { treatment_interest: 'cosmetic' } }))
    ).toEqual(['cosmetic'])
  })

  it('classifies a lead with both implant and niche signals as both', () => {
    const out = classifyLeadServiceLines(
      lead({ custom_fields: { treatment_interest: 'implant' }, tags: ['src:tmj'] })
    )
    expect(out).toContain('implants')
    expect(out).toContain('tmj')
  })
})

describe('serviceLineOrFilter', () => {
  it('niche filters are positive conditions only', () => {
    const or = serviceLineOrFilter('tmj')
    expect(or).toContain('tags.cs.{"src:tmj"}')
    expect(or).not.toContain('not.or(')
  })

  it('implants filter adds a null-safe niche-exclusion residual clause', () => {
    const or = serviceLineOrFilter('implants')!
    // still carries the explicit implant signals
    expect(or).toContain('tags.cs.{"full-arch-cold"}')
    // …plus the residual: an AND of NULL-safe negations of every niche signal
    expect(or).toContain('and(')
    expect(or).toContain('tags.not.cs.{"src:tmj"}') // niche tag negated
    expect(or).toContain('utm_campaign.is.null') // null-safe keyword guard
    expect(or).toContain('utm_campaign.not.ilike.%tmj%')
    expect(or).toContain('custom_fields->>treatment_interest.not.in.(cosmetic,tmj,sleep_apnea,lanap)')
  })

  it('returns null for an unknown service', () => {
    expect(serviceLineOrFilter('nope')).toBeNull()
  })
})

describe('serviceLineFromPipelineName (Part 2 — GHL pipeline → service)', () => {
  it('maps implant pipelines', () => {
    expect(serviceLineFromPipelineName('AOX Nurturing Database')).toBe('implants')
    expect(serviceLineFromPipelineName('Full Arch Leads')).toBe('implants')
    expect(serviceLineFromPipelineName('All-on-4 Consults')).toBe('implants')
    expect(serviceLineFromPipelineName('Dental Implants')).toBe('implants')
  })

  it('maps niche pipelines to their service', () => {
    expect(serviceLineFromPipelineName('TMJ Pipeline')).toBe('tmj')
    expect(serviceLineFromPipelineName('Sleep Apnea')).toBe('sleep_apnea')
    expect(serviceLineFromPipelineName('Veneers / Cosmetic')).toBe('cosmetic')
    expect(serviceLineFromPipelineName('LANAP')).toBe('lanap')
  })

  it('returns null for an unrecognised / empty pipeline name', () => {
    expect(serviceLineFromPipelineName('General Intake')).toBeNull()
    expect(serviceLineFromPipelineName('')).toBeNull()
    expect(serviceLineFromPipelineName(null)).toBeNull()
  })
})

describe('landing_page_url as a niche signal (GMB/organic leads)', () => {
  // The real 2026-07-14 miss: GMB-listing TMJ lead whose UTMs carry no
  // treatment keyword — the only signal is the per-DBA landing domain.
  const gmbTmjLead = lead({
    utm_source: 'GMBlisting',
    utm_campaign: 'Gmb-apt',
    landing_page_url:
      'https://www.tmjandsleepapneasanfrancisco.com/contact/?utm_source=GMBlisting&utm_medium=organic&utm_campaign=gmb-apt',
  })

  it('classifies a GMB lead by its landing domain instead of the implants residual', () => {
    const out = classifyLeadServiceLines(gmbTmjLead)
    expect(out).toContain('tmj')
    // shared TMJ + sleep-apnea DBA domain matches both niches
    expect(out).toContain('sleep_apnea')
    expect(out).not.toContain('implants')
  })

  it('never matches implants keywords against URLs (arch ⊂ search)', () => {
    const out = classifyLeadServiceLines(
      lead({ tags: ['src:tmj'], landing_page_url: 'https://example.com/search?q=dentist' })
    )
    expect(out).toEqual(['tmj'])
  })

  it('a URL-only implant page still lands on implants via the residual', () => {
    expect(
      classifyLeadServiceLines(lead({ landing_page_url: 'https://example.com/dental-implants' }))
    ).toEqual(['implants'])
  })

  it('niche SQL filter matches landing_page_url; implants residual excludes it null-safely', () => {
    expect(serviceLineOrFilter('tmj')).toContain('landing_page_url.ilike.%tmj%')
    const residual = serviceLineOrFilter('implants')!
    expect(residual).toContain('or(landing_page_url.is.null,landing_page_url.not.ilike.%tmj%)')
    // implants keywords never target the URL column
    expect(residual).not.toContain('landing_page_url.ilike.%arch%')
  })
})

describe('serviceLineFromIntakeSignals (bridge ingest stamper)', () => {
  it('prefers the form message over the shared-domain URL', () => {
    expect(
      serviceLineFromIntakeSignals({
        message: 'contact-us-tmj',
        landingPageUrl: 'https://www.tmjandsleepapneasanfrancisco.com/contact/',
      })
    ).toBe('tmj')
  })

  it('falls back to the landing domain when the message carries no signal', () => {
    expect(
      serviceLineFromIntakeSignals({
        message: 'I would like an appointment',
        landingPageUrl: 'https://www.tmjandsleepapneasanfrancisco.com/contact/',
      })
    ).toBe('tmj')
  })

  it('never stamps implants — the residual owns unsignalled leads', () => {
    expect(
      serviceLineFromIntakeSignals({ landingPageUrl: 'https://example.com/dental-implants' })
    ).toBeNull()
    expect(serviceLineFromIntakeSignals({ message: null, landingPageUrl: null })).toBeNull()
  })
})
