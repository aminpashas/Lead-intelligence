import { describe, it, expect } from 'vitest'
import { renderVisitLogistics } from '@/lib/branding/visit-logistics'
import type { ResolvedBrand } from '@/lib/branding/resolve-brand'
import type { BrandLogistics } from '@/lib/branding/schema'

const brand = (logistics: Partial<BrandLogistics>): ResolvedBrand => ({
  practiceName: 'Dion Health',
  doctorName: null,
  website: null,
  logistics: {
    addressText: '',
    drivingText: '',
    parkingText: '',
    transitText: '',
    whatToExpectText: '',
    ...logistics,
  },
})

describe('renderVisitLogistics', () => {
  it('returns everything empty when no logistics are entered', () => {
    const r = renderVisitLogistics(brand({}))
    expect(r.smsSuffix).toBe('')
    expect(r.emailHtml).toBe('')
    expect(r.emailText).toBe('')
  })

  it('builds a concise SMS suffix from address + car + BART (not what-to-expect)', () => {
    const r = renderVisitLogistics(
      brand({
        addressText: '450 Sutter St, Ste 1519',
        drivingText: 'Corner of Sutter & Powell',
        transitText: 'Powell St BART, 3 blocks',
        whatToExpectText: 'Bring your ID.',
      })
    )
    expect(r.smsSuffix).toBe(
      '450 Sutter St, Ste 1519 By car: Corner of Sutter & Powell By BART: Powell St BART, 3 blocks'
    )
    // "What to expect" is email-only — it must never bloat the SMS.
    expect(r.smsSuffix).not.toContain('Bring your ID')
  })

  it('renders a Getting here card and a What to expect card in the email', () => {
    const r = renderVisitLogistics(
      brand({ addressText: '450 Sutter St', parkingText: 'Sutter-Stockton garage', whatToExpectText: 'Arrive early.' })
    )
    expect(r.emailHtml).toContain('Getting here')
    expect(r.emailHtml).toContain('450 Sutter St')
    expect(r.emailHtml).toContain('<strong>Parking:</strong> Sutter-Stockton garage')
    expect(r.emailHtml).toContain('What to expect')
    expect(r.emailHtml).toContain('Arrive early.')
    expect(r.emailText).toContain('Getting here:')
    expect(r.emailText).toContain('What to expect:\nArrive early.')
  })

  it('escapes HTML in the email but leaves the SMS/plain-text raw', () => {
    const r = renderVisitLogistics(brand({ addressText: 'A & B <Suite>' }))
    expect(r.emailHtml).toContain('A &amp; B &lt;Suite&gt;')
    expect(r.smsSuffix).toBe('A & B <Suite>')
  })

  it('omits the What to expect card when only directions are set', () => {
    const r = renderVisitLogistics(brand({ addressText: '450 Sutter St' }))
    expect(r.emailHtml).toContain('Getting here')
    expect(r.emailHtml).not.toContain('What to expect')
  })
})
