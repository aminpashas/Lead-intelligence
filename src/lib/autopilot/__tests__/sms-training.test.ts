import { describe, it, expect } from 'vitest'
import { parseTrainerCommand, normalizeE164, isTrainerNumber, handleTrainerSms } from '@/lib/autopilot/sms-training'

describe('parseTrainerCommand', () => {
  it('parses TRAIN with a pin', () => {
    expect(parseTrainerCommand('TRAIN 4821')).toEqual({ kind: 'train', pin: '4821' })
  })
  it('parses ROLEPLAY with pin + scenario', () => {
    expect(parseTrainerCommand('ROLEPLAY 4821 cost objection')).toEqual({
      kind: 'roleplay', pin: '4821', scenario: 'cost objection',
    })
  })
  it('parses ROLEPLAY with pin only (no scenario)', () => {
    expect(parseTrainerCommand('roleplay 4821')).toEqual({ kind: 'roleplay', pin: '4821', scenario: null })
  })
  it('parses RULE with the remaining text', () => {
    expect(parseTrainerCommand('RULE never quote a price before booking')).toEqual({
      kind: 'rule', text: 'never quote a price before booking',
    })
  })
  it('parses FIX with guidance', () => {
    expect(parseTrainerCommand('FIX be warmer and shorter')).toEqual({ kind: 'fix', guidance: 'be warmer and shorter' })
  })
  it('parses bare control words case-insensitively', () => {
    expect(parseTrainerCommand('save')).toEqual({ kind: 'save' })
    expect(parseTrainerCommand('DONE')).toEqual({ kind: 'done' })
    expect(parseTrainerCommand('exit')).toEqual({ kind: 'done' })
    expect(parseTrainerCommand('HELP')).toEqual({ kind: 'help' })
    expect(parseTrainerCommand('status')).toEqual({ kind: 'status' })
  })
  it('treats anything else as free text', () => {
    expect(parseTrainerCommand('I want to know about the cost')).toEqual({
      kind: 'text', text: 'I want to know about the cost',
    })
  })
  it('does NOT treat STOP as an exit (reserved TCPA opt-out passes through as text)', () => {
    expect(parseTrainerCommand('STOP')).toEqual({ kind: 'text', text: 'STOP' })
  })
})

describe('normalizeE164 / isTrainerNumber', () => {
  it('normalizes US 10- and 11-digit numbers to E.164', () => {
    expect(normalizeE164('4156767420')).toBe('+14156767420')
    expect(normalizeE164('14156767420')).toBe('+14156767420')
    expect(normalizeE164('+1 (415) 676-7420')).toBe('+14156767420')
  })
  it('matches against an allowlist regardless of formatting', () => {
    const allow = ['+14156767420']
    expect(isTrainerNumber('4156767420', allow)).toBe(true)
    expect(isTrainerNumber('+14156767420', allow)).toBe(true)
    expect(isTrainerNumber('+15550001111', allow)).toBe(false)
  })
})

// Minimal supabase stub: config query returns allowlist + pin; no active session.
function stubSupabase() {
  return {
    from(table: string) {
      if (table === 'agency_settings') {
        return { select: () => ({ in: () => ({ data: [
          { key: 'sms_trainer_numbers', value: ['+14156767420'] },
          { key: 'training_pin', value: '4821' },
        ] }) }) }
      }
      if (table === 'sms_training_sessions') {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => ({ data: null }) }) }) }),
        }
      }
      return { select: () => ({ eq: () => ({ data: [] }) }) }
    },
  } as never
}

describe('handleTrainerSms', () => {
  it('ignores non-trainer numbers (falls through)', async () => {
    const r = await handleTrainerSms(stubSupabase(), { from: '+15550001111', body: 'hi' })
    expect(r.handled).toBe(false)
  })
  it('rejects a wrong PIN on TRAIN', async () => {
    const r = await handleTrainerSms(stubSupabase(), { from: '+14156767420', body: 'TRAIN 0000' })
    expect(r.handled).toBe(true)
    expect(r.reply).toContain('Invalid PIN')
  })
  it('HELP works without a session', async () => {
    const r = await handleTrainerSms(stubSupabase(), { from: '+14156767420', body: 'HELP' })
    expect(r.reply).toContain('TRAIN <pin>')
  })
  it('a trainer number with no session + non-command text falls through to the lead pipeline', async () => {
    const r = await handleTrainerSms(stubSupabase(), {
      from: '+14156767420',
      body: 'Yes can you send me the application',
    })
    expect(r.handled).toBe(false)
    expect(r.reply).toBeNull()
  })
})
