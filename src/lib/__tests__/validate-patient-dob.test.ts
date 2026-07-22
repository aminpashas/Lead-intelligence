import { describe, it, expect } from 'vitest'
import { validatePatientDob } from '@/lib/autopilot/agent-tools'

describe('validatePatientDob', () => {
  it('accepts a normal adult DOB', () => {
    expect(validatePatientDob('1970-06-05')).toBeNull()
    expect(validatePatientDob('1999-12-31')).toBeNull()
  })

  it('rejects non-ISO formats the model might emit from speech', () => {
    expect(validatePatientDob('June 5th 1970')).toContain('YYYY-MM-DD')
    expect(validatePatientDob('06/05/1970')).toContain('YYYY-MM-DD')
    expect(validatePatientDob('1970-6-5')).toContain('YYYY-MM-DD')
  })

  it('rejects calendar-impossible dates (transcription artifacts)', () => {
    expect(validatePatientDob('1970-02-30')).toContain('transcribed wrong')
    expect(validatePatientDob('1970-13-01')).toContain('transcribed wrong')
  })

  it('rejects future dates and implausible ages', () => {
    expect(validatePatientDob('2099-01-01')).toContain('transcribed wrong')
    expect(validatePatientDob('1850-01-01')).toContain('transcribed wrong')
  })
})
