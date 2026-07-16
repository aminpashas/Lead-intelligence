import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { executeAgentTool } from '@/lib/autopilot/agent-tools'

// The same-channel guard must fire before ANY I/O, so a Supabase client that
// explodes on first touch proves the refusal has zero side effects (no Twilio
// send, no messages row, no cross_channel_sms_sent activity).
const untouchableSupabase = new Proxy({}, {
  get() {
    throw new Error('supabase must not be touched by a same-channel refusal')
  },
}) as unknown as SupabaseClient

function makeContext(channel: string | undefined, lead: Record<string, unknown> = {}) {
  return {
    organization_id: 'org-1',
    lead_id: 'lead-1',
    lead,
    conversation_id: 'conv-1',
    channel,
  }
}

describe('send_sms_to_lead same-channel guard', () => {
  it('soft-refuses in an SMS conversation and tells the model to reply inline', async () => {
    const result = await executeAgentTool(
      untouchableSupabase,
      'send_sms_to_lead',
      { message: 'Here is your financing info: https://example.com/f/abc' },
      makeContext('sms', { sms_consent: true, sms_opt_out: false }),
    )

    expect(result.success).toBe(false)
    expect(result.data.same_channel).toBe(true)
    // The refusal must redirect the model to its reply, not just say "failed".
    expect(result.message).toMatch(/directly in your reply/i)
  })

  it('still allows the cross-channel use (voice → SMS) past the guard', async () => {
    // An opted-out (DND) lead lets the call fall through the same-channel guard and
    // hit the opt-out check instead — proving voice was NOT blocked by the guard
    // without needing to mock the Twilio send path. (Consent is now assumed, so a
    // bare consent-less lead would send; DND is the pre-I/O short-circuit.)
    const result = await executeAgentTool(
      untouchableSupabase,
      'send_sms_to_lead',
      { message: 'Texting you the address now.' },
      makeContext('voice', { sms_opt_out: true }),
    )

    expect(result.success).toBe(false)
    expect(result.data.same_channel).toBeUndefined()
    expect(result.message).toMatch(/opted out/i)
  })

  it('treats an unknown channel as cross-channel (guard only fires on sms)', async () => {
    const result = await executeAgentTool(
      untouchableSupabase,
      'send_sms_to_lead',
      { message: 'hello' },
      makeContext(undefined, { sms_opt_out: true }),
    )

    expect(result.data.same_channel).toBeUndefined()
    expect(result.message).toMatch(/opted out/i)
  })
})
