import { describe, it, expect } from 'vitest'
import { parseBranding, DEFAULT_BRANDING, BRAND_SLUGS } from '@/lib/branding/schema'

describe('parseBranding', () => {
  it('returns the default structure for null/garbage input', () => {
    expect(parseBranding(null)).toEqual(DEFAULT_BRANDING)
    expect(parseBranding('nope')).toEqual(DEFAULT_BRANDING)
    expect(parseBranding(undefined)).toEqual(DEFAULT_BRANDING)
  })

  it('always exposes the three canonical brand slots', () => {
    const b = parseBranding({})
    for (const slug of BRAND_SLUGS) expect(b.brands[slug]).toBeDefined()
  })

  it('overlays entered brand values onto the defaults', () => {
    const b = parseBranding({
      brands: { dion_health: { name: 'Dion Health', doctorName: 'Dr. Amin Samadian', website: 'dionhealth.com' } },
      logistics: { parkingText: 'Sutter-Stockton garage' },
    })
    expect(b.brands.dion_health.name).toBe('Dion Health')
    expect(b.brands.dion_health.doctorName).toBe('Dr. Amin Samadian')
    expect(b.logistics.parkingText).toBe('Sutter-Stockton garage')
    expect(b.brands.sf_dentistry.name).toBe('')
    expect(b.logistics.addressText).toBe('')
  })

  it('parses the by-car and what-to-expect logistics fields', () => {
    const b = parseBranding({
      logistics: {
        addressText: '450 Sutter St',
        drivingText: 'Corner of Sutter & Powell',
        transitText: 'Powell St BART',
        whatToExpectText: 'Arrive 10 min early. Bring ID.',
      },
    })
    expect(b.logistics.drivingText).toBe('Corner of Sutter & Powell')
    expect(b.logistics.whatToExpectText).toBe('Arrive 10 min early. Bring ID.')
    // Unsent keys still default to empty strings.
    expect(b.logistics.parkingText).toBe('')
  })

  it('keeps the standard service-line → brand mapping and default brand', () => {
    const b = parseBranding({})
    expect(b.serviceLineToBrand.implants).toBe('dion_health')
    expect(b.serviceLineToBrand.tmj).toBe('tmj_sleep')
    expect(b.serviceLineToBrand.sleep_apnea).toBe('tmj_sleep')
    expect(b.serviceLineToBrand.cosmetic).toBe('sf_dentistry')
    expect(b.defaultBrand).toBe('sf_dentistry')
  })
})
