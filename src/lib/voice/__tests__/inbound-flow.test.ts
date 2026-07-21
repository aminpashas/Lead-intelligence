import { describe, it, expect } from 'vitest'
import {
  inboundSettingsFromOrg,
  ringAgentsTwiml,
  voicemailTwiml,
  retellSipTwiml,
} from '@/lib/voice/inbound-flow'

/**
 * These pin the inbound routing policy + the TwiML the live caller actually
 * hears. Twilio parses this XML with zero forgiveness, and a malformed response
 * means dead air on a real patient call — so the shapes are asserted literally.
 */

describe('inboundSettingsFromOrg', () => {
  it('defaults to AI-answers (the pre-feature behavior) on a null/legacy org row', () => {
    // A deployment whose migration hasn't run yet returns rows without the
    // inbound_* columns — every org must keep behaving exactly as before.
    expect(inboundSettingsFromOrg(null).mode).toBe('ai')
    expect(inboundSettingsFromOrg({}).mode).toBe('ai')
    expect(inboundSettingsFromOrg({ name: 'X' }).aiOnNoAnswer).toBe(false)
    expect(inboundSettingsFromOrg({}).aiAfterHours).toBe(false)
    expect(inboundSettingsFromOrg({}).ringSeconds).toBe(20)
  })

  it('reads an armed ring-agents policy', () => {
    const s = inboundSettingsFromOrg({
      inbound_call_mode: 'ring_agents',
      inbound_ai_on_no_answer: true,
      inbound_ai_after_hours: true,
      inbound_ring_seconds: 30,
      inbound_voicemail_greeting: 'Hi!',
    })
    expect(s).toEqual({
      mode: 'ring_agents',
      aiOnNoAnswer: true,
      aiAfterHours: true,
      ringSeconds: 30,
      voicemailGreeting: 'Hi!',
    })
  })

  it('clamps the ring window to something a caller will tolerate', () => {
    expect(inboundSettingsFromOrg({ inbound_ring_seconds: 3 }).ringSeconds).toBe(5)
    expect(inboundSettingsFromOrg({ inbound_ring_seconds: 500 }).ringSeconds).toBe(60)
    expect(inboundSettingsFromOrg({ inbound_ring_seconds: 'nope' }).ringSeconds).toBe(20)
  })
})

describe('ringAgentsTwiml', () => {
  const base = {
    ringSeconds: 20,
    actionUrl: 'https://app.example.com/api/voice/inbound/dial-result?vc=abc',
    voiceCallId: 'abc',
    leadId: 'lead-1',
    leadName: 'Pat Smith',
  }

  it('rings phone targets as <Number> and softphone reps as <Client> with call params', () => {
    const xml = ringAgentsTwiml({
      ...base,
      targets: [
        { id: 't1', kind: 'phone', destination: '+14155550100', user_id: null, name: 'Front desk' },
        { id: 't2', kind: 'softphone_user', destination: null, user_id: 'u-42', name: 'Sam' },
      ],
    })
    expect(xml).toContain('<Number>+14155550100</Number>')
    expect(xml).toContain('<Identity>staff_u-42</Identity>')
    // The widget needs these to disposition against the right voice_calls row.
    expect(xml).toContain('<Parameter name="voiceCallId" value="abc"/>')
    expect(xml).toContain('<Parameter name="leadId" value="lead-1"/>')
    expect(xml).toContain('<Parameter name="leadName" value="Pat Smith"/>')
    expect(xml).toContain('timeout="20"')
    // The action URL's & would break the XML unescaped.
    expect(xml).toContain('action="https://app.example.com/api/voice/inbound/dial-result?vc=abc"')
  })

  it('drops undialable targets instead of emitting empty nouns', () => {
    const xml = ringAgentsTwiml({
      ...base,
      targets: [
        { id: 't1', kind: 'phone', destination: null, user_id: null, name: 'Broken' },
        { id: 't2', kind: 'phone', destination: '+14155550100', user_id: null, name: 'OK' },
      ],
    })
    expect(xml).not.toContain('<Number></Number>')
    expect(xml).toContain('<Number>+14155550100</Number>')
  })

  it('XML-escapes a lead name that would otherwise break the document', () => {
    const xml = ringAgentsTwiml({
      ...base,
      leadName: `O'Brien <& Sons>`,
      targets: [{ id: 't2', kind: 'softphone_user', destination: null, user_id: 'u-1', name: 'S' }],
    })
    expect(xml).toContain('O&apos;Brien &lt;&amp; Sons&gt;')
    expect(xml).not.toContain('<& Sons>')
  })
})

describe('voicemailTwiml', () => {
  it('speaks the custom greeting and wires both callbacks (with escaped query separators)', () => {
    const xml = voicemailTwiml({
      greeting: 'Leave a message & we will call back',
      practiceName: 'SF Dentistry',
      actionUrl: 'https://app.example.com/api/voice/inbound/voicemail?vc=abc',
      transcribeCallbackUrl: 'https://app.example.com/api/voice/inbound/voicemail?vc=abc&kind=transcript',
    })
    expect(xml).toContain('<Say>Leave a message &amp; we will call back</Say>')
    expect(xml).toContain('action="https://app.example.com/api/voice/inbound/voicemail?vc=abc"')
    expect(xml).toContain('transcribeCallback="https://app.example.com/api/voice/inbound/voicemail?vc=abc&amp;kind=transcript"')
    expect(xml).toContain('transcribe="true"')
  })

  it('falls back to a practice-named default greeting', () => {
    const xml = voicemailTwiml({
      greeting: null,
      practiceName: 'SF Dentistry',
      actionUrl: 'https://x/vm',
      transcribeCallbackUrl: 'https://x/vm?kind=transcript',
    })
    expect(xml).toContain('Thank you for calling SF Dentistry.')
  })
})

describe('retellSipTwiml', () => {
  it('bridges to the registered Retell call over SIP', () => {
    expect(retellSipTwiml('call_123')).toContain(
      '<Sip>sip:call_123@sip.retellai.com;transport=tcp</Sip>'
    )
  })
})
