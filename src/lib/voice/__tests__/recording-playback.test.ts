import { describe, it, expect } from 'vitest'
import { recordingPlaybackUrl, isTwilioRecordingUrl } from '../recording-playback'
import { recordingSidFromUrl } from '../transcribe'

const TWILIO_URL =
  'https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/Recordings/RE11111111111111111111111111111111'
const RETELL_URL = 'https://dxc03zgurdly9.cloudfront.net/recordings/call_abc.wav'

describe('recordingPlaybackUrl', () => {
  it('routes Twilio recordings through the authenticated proxy', () => {
    expect(recordingPlaybackUrl('call-1', TWILIO_URL)).toBe('/api/voice/recording/call-1')
  })

  it('plays public (Retell) recordings directly', () => {
    expect(recordingPlaybackUrl('call-1', RETELL_URL)).toBe(RETELL_URL)
  })

  it('returns null when there is no recording', () => {
    expect(recordingPlaybackUrl('call-1', null)).toBeNull()
    expect(recordingPlaybackUrl('call-1', undefined)).toBeNull()
  })
})

describe('isTwilioRecordingUrl', () => {
  it('matches only api.twilio.com', () => {
    expect(isTwilioRecordingUrl(TWILIO_URL)).toBe(true)
    expect(isTwilioRecordingUrl(RETELL_URL)).toBe(false)
    expect(isTwilioRecordingUrl('https://evil.example/api.twilio.com/x')).toBe(false)
  })
})

describe('recordingSidFromUrl', () => {
  it('extracts the RE sid', () => {
    expect(recordingSidFromUrl(TWILIO_URL)).toBe('RE11111111111111111111111111111111')
  })

  it('returns null when absent', () => {
    expect(recordingSidFromUrl(RETELL_URL)).toBeNull()
  })
})
