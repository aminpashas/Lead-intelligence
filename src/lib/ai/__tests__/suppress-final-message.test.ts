import { describe, it, expect } from 'vitest'
import { shouldSuppressFinalMessage } from '@/lib/ai/agent-loop'

// Regression: patient said "yes" to a testimonial; the tool texted the video AND
// the agent's final reply was sent too — two texts. When a same-channel send
// happened and the final reply is just a short ack, drop it.
describe('shouldSuppressFinalMessage', () => {
  it('never suppresses when no same-channel send happened', () => {
    expect(shouldSuppressFinalMessage(false, 'Just sent that over!')).toBe(false)
  })

  it('suppresses a short acknowledgment after a same-channel send', () => {
    expect(shouldSuppressFinalMessage(true, 'Just sent that over — take a look! 😊')).toBe(true)
  })

  it('suppresses an empty final message', () => {
    expect(shouldSuppressFinalMessage(true, '   ')).toBe(true)
  })

  it('keeps a final message that asks the patient a question', () => {
    expect(shouldSuppressFinalMessage(true, 'Sent it! Want me to send another?')).toBe(false)
  })

  it('keeps a substantive (long) final message so no content is lost', () => {
    const long =
      'Sent that over! Also, to answer your earlier question — parking is free in the ' +
      'garage right next door on Sutter, and the office validates it at the front desk too.'
    expect(shouldSuppressFinalMessage(true, long)).toBe(false)
  })
})
