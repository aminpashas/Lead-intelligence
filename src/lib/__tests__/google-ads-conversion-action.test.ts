import { describe, it, expect } from 'vitest'
import {
  resolveConversionActionResource,
  conversionActionError,
} from '@/lib/connectors/google-ads/conversion-action'

describe('resolveConversionActionResource', () => {
  it('uses a persisted resource name verbatim when present', () => {
    expect(
      resolveConversionActionResource('customers/123/conversionActions/456', '123', 'Consultation Booked')
    ).toBe('customers/123/conversionActions/456')
  })

  it('trims a persisted resource name', () => {
    expect(
      resolveConversionActionResource('  customers/123/conversionActions/456  ', '123', null)
    ).toBe('customers/123/conversionActions/456')
  })

  it('formats a bare numeric conversion-action ID into a valid resource name', () => {
    expect(resolveConversionActionResource(null, '123', '789')).toBe(
      'customers/123/conversionActions/789'
    )
  })

  it('refuses a display-name label (the old silent-4xx path) → null', () => {
    expect(resolveConversionActionResource(null, '123', 'Consultation Booked')).toBeNull()
    expect(resolveConversionActionResource(undefined, '123', 'payment_received')).toBeNull()
    expect(resolveConversionActionResource('', '123', 'lead-qualified')).toBeNull()
  })

  it('returns null when there is nothing usable at all', () => {
    expect(resolveConversionActionResource(null, '123', null)).toBeNull()
    expect(resolveConversionActionResource(null, '123', '')).toBeNull()
  })

  it('error message is actionable and names the offending label', () => {
    const msg = conversionActionError('contract.signed', 'Consultation Booked')
    expect(msg).toContain('contract.signed')
    expect(msg).toContain('Consultation Booked')
    expect(msg).toContain('resource name')
  })
})
