import { describe, it, expect } from 'vitest'
import { resolveConversationAiGate } from '@/lib/autopilot/config'

describe('resolveConversationAiGate', () => {
  it('proceeds in the normal case (auto mode, no override)', () => {
    expect(resolveConversationAiGate('default', 'auto')).toBe('proceed')
    expect(resolveConversationAiGate(null, undefined)).toBe('proceed')
    expect(resolveConversationAiGate('force_on', 'auto')).toBe('proceed')
  })

  it('silences autonomous replies when the conversation ai_mode is off', () => {
    expect(resolveConversationAiGate('default', 'off')).toBe('silence')
    // conversation "off" is the most specific human instruction — it wins even
    // over a lead force_on / assist_only.
    expect(resolveConversationAiGate('force_on', 'off')).toBe('silence')
    expect(resolveConversationAiGate('assist_only', 'off')).toBe('silence')
  })

  it('forces assist (draft + escalate) from either source', () => {
    expect(resolveConversationAiGate('default', 'assist')).toBe('assist')
    expect(resolveConversationAiGate('assist_only', 'auto')).toBe('assist')
    expect(resolveConversationAiGate('assist_only', 'assist')).toBe('assist')
  })

  it('off outranks assist', () => {
    expect(resolveConversationAiGate('assist_only', 'off')).toBe('silence')
  })
})
