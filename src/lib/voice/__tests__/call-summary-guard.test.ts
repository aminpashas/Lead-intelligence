import { describe, it, expect } from 'vitest'
import { hasOwnTranscript } from '@/lib/voice/call-summary-guard'

/**
 * These pin the data-loss guard on the disposition route. Amending the notes on
 * a call recomposes `transcript_summary` — correct for a staff call, destructive
 * for an AI call whose summary is a real generated record of the conversation.
 */
describe('hasOwnTranscript', () => {
  describe('calls whose summary must be preserved', () => {
    it('protects an AI call carrying a transcript array', () => {
      expect(hasOwnTranscript({
        call_mode: 'ai',
        transcript: [{ role: 'agent', content: 'Hi, calling about your consult' }],
      } as never)).toBe(true)
    })

    it('protects an AI call whose transcript has not landed yet', () => {
      // Transcription is asynchronous. A staffer amending notes in the gap
      // between the call ending and the transcript arriving must not have the
      // incoming summary clobbered.
      expect(hasOwnTranscript({ call_mode: 'ai', transcript: [] } as never)).toBe(true)
      expect(hasOwnTranscript({ call_mode: 'ai', transcript: null } as never)).toBe(true)
    })

    it('protects any call that already has a plain-text transcript', () => {
      expect(hasOwnTranscript({
        call_mode: 'bridge',
        transcript: 'Agent: hello\nUser: hi',
      } as never)).toBe(true)
    })
  })

  describe('calls whose summary is safe to recompose', () => {
    it('allows a staff browser call with no transcript', () => {
      // The composed one-liner IS the record for these — there is nothing to lose.
      expect(hasOwnTranscript({ call_mode: 'browser', transcript: [] } as never)).toBe(false)
      expect(hasOwnTranscript({ call_mode: 'browser', transcript: null } as never)).toBe(false)
    })

    it('treats an empty or whitespace-only transcript as absent', () => {
      expect(hasOwnTranscript({ call_mode: 'browser', transcript: '' } as never)).toBe(false)
      expect(hasOwnTranscript({ call_mode: 'browser', transcript: '   \n ' } as never)).toBe(false)
    })

    it('allows a manually logged call', () => {
      expect(hasOwnTranscript({ call_mode: null, transcript: null } as never)).toBe(false)
    })
  })
})
