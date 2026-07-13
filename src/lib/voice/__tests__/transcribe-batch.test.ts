import { describe, it, expect } from 'vitest'
import {
  needsTranscription,
  selectTranscribeCandidates,
  readTranscribeMeta,
  MAX_TRANSCRIBE_ATTEMPTS,
  type TranscribeCandidateRow,
} from '../transcribe-batch'

const TWILIO_URL =
  'https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/Recordings/RE11111111111111111111111111111111'
const RETELL_URL = 'https://dxc03zgurdly9.cloudfront.net/recordings/call_abc.wav'

function row(overrides: Partial<TranscribeCandidateRow> = {}): TranscribeCandidateRow {
  return {
    id: 'call-1',
    organization_id: 'org-1',
    recording_url: TWILIO_URL,
    transcript: [],
    transcript_summary: null,
    metadata: {},
    ...overrides,
  }
}

describe('needsTranscription', () => {
  it('accepts a completed Twilio recording with no transcript', () => {
    expect(needsTranscription(row())).toBe(true)
  })

  it('rejects rows without a recording', () => {
    expect(needsTranscription(row({ recording_url: null }))).toBe(false)
  })

  it('rejects Retell recordings — those already carry their own transcript', () => {
    expect(needsTranscription(row({ recording_url: RETELL_URL }))).toBe(false)
  })

  it('rejects rows that already have a transcript (array form)', () => {
    expect(
      needsTranscription(row({ transcript: [{ role: 'agent', content: 'hi there' }] }))
    ).toBe(false)
  })

  it('rejects rows that already have a transcript (plain-text form)', () => {
    expect(needsTranscription(row({ transcript: 'Agent: hello\nUser: hi' }))).toBe(false)
  })

  it('rejects rows already marked done', () => {
    expect(needsTranscription(row({ metadata: { transcribe_status: 'done' } }))).toBe(false)
  })

  it('rejects rows that exhausted the retry budget', () => {
    expect(
      needsTranscription(row({ metadata: { transcribe_attempts: MAX_TRANSCRIBE_ATTEMPTS } }))
    ).toBe(false)
  })

  it('still accepts a row mid-retry below the budget', () => {
    expect(
      needsTranscription(row({ metadata: { transcribe_attempts: MAX_TRANSCRIBE_ATTEMPTS - 1 } }))
    ).toBe(true)
  })
})

describe('selectTranscribeCandidates', () => {
  it('prioritizes in-progress (resuming) rows over fresh ones', () => {
    const fresh = row({ id: 'fresh' })
    const resuming = row({
      id: 'resuming',
      metadata: { transcribe_status: 'processing', intelligence_transcript_sid: 'GT123' },
    })
    const picked = selectTranscribeCandidates([fresh, resuming], 10)
    expect(picked.map((r) => r.id)).toEqual(['resuming', 'fresh'])
  })

  it('caps the batch at batchSize', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row({ id: `c${i}` }))
    expect(selectTranscribeCandidates(rows, 12)).toHaveLength(12)
  })

  it('drops ineligible rows before slicing', () => {
    const rows = [
      row({ id: 'ok' }),
      row({ id: 'retell', recording_url: RETELL_URL }),
      row({ id: 'done', metadata: { transcribe_status: 'done' } }),
    ]
    expect(selectTranscribeCandidates(rows, 12).map((r) => r.id)).toEqual(['ok'])
  })

  it('returns nothing for a non-positive batch size', () => {
    expect(selectTranscribeCandidates([row()], 0)).toHaveLength(0)
  })
})

describe('readTranscribeMeta', () => {
  it('defaults cleanly on empty/absent metadata', () => {
    expect(readTranscribeMeta(null)).toEqual({
      intelligence_transcript_sid: null,
      transcribe_status: undefined,
      transcribe_attempts: 0,
      transcribe_error: null,
    })
  })

  it('reads back stored bookkeeping', () => {
    expect(
      readTranscribeMeta({
        intelligence_transcript_sid: 'GT9',
        transcribe_status: 'processing',
        transcribe_attempts: 2,
        transcribe_error: 'boom',
      })
    ).toEqual({
      intelligence_transcript_sid: 'GT9',
      transcribe_status: 'processing',
      transcribe_attempts: 2,
      transcribe_error: 'boom',
    })
  })

  it('ignores an unknown transcribe_status', () => {
    expect(readTranscribeMeta({ transcribe_status: 'bogus' }).transcribe_status).toBeUndefined()
  })
})
