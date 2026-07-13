import { describe, it, expect } from 'vitest'
import {
  classifyTestOrSpamLead,
  spamDisqualifiedReason,
} from '@/lib/leads/test-spam-contact'

describe('classifyTestOrSpamLead — solicitation', () => {
  it('flags the canonical "Donald" DGS-form B2B pitch', () => {
    expect(
      classifyTestOrSpamLead({
        first_name: 'Donald',
        notes:
          'Source: website_contact_form\ndgs_lead_id: 4439fa2d\nMessage: Dion Growth Studio, your brand development services help healthcare practices build trust. We can refresh your visual identity and messaging to attract more referrals. Open to a quick chat?',
      }),
    ).toBe('solicitation')
  })

  it('flags common vendor-spam phrasings', () => {
    const pitches = [
      'I can build backlinks and improve your rankings',
      'We specialize in digital marketing services for clinics',
      'Interested in a guest post / link building partnership?',
      'Great crypto investment opportunity, guaranteed returns',
      'We can help increase your traffic and leads',
    ]
    for (const notes of pitches) {
      expect(classifyTestOrSpamLead({ first_name: 'Alex', notes })).toBe('solicitation')
    }
  })
})

describe('classifyTestOrSpamLead — test records', () => {
  it('flags unambiguous test names (first or last)', () => {
    const names: [string, string | null][] = [
      ['Test', 'Test'],
      ['test', 'progressive test dental'],
      ['john', 'test'],
      ['testing', 'testing'],
      ['test2', 'test'],
      ['final', 'test - please ignore final test'],
      ['sasha', 'testing testing'],
    ]
    for (const [first_name, last_name] of names) {
      expect(classifyTestOrSpamLead({ first_name, last_name })).toBe('test_record')
    }
  })

  it('flags throwaway placeholder PAIRS but not a lone placeholder', () => {
    expect(classifyTestOrSpamLead({ first_name: 'abc', last_name: 'xyz' })).toBe('test_record')
    // A lone "Abc" is ambiguous — left as a lead on purpose (high precision).
    expect(classifyTestOrSpamLead({ first_name: 'Abc', last_name: null })).toBeNull()
  })

  it('flags explicit test phrases in notes', () => {
    expect(
      classifyTestOrSpamLead({ first_name: 'Jane', notes: 'please ignore, this is a test' }),
    ).toBe('test_record')
  })
})

describe('classifyTestOrSpamLead — genuine leads are NOT flagged', () => {
  it('keeps real patients whose message carries channel/condition tags', () => {
    // These are the false-positive traps: "seo lead"/"web"/"missing teeth" are
    // channel tags + dental conditions on REAL leads, not spam.
    const realNotes = [
      'web, missing multiple teeth, seo lead, no campaign, morgan_hill, new progressive',
      'seo lead, berkeley, in communication, new progressive',
      'ppc new lead, missing all teeth, seo new lead, dental implant, aox nurturing pipeline',
    ]
    for (const notes of realNotes) {
      expect(classifyTestOrSpamLead({ first_name: 'Maria', last_name: 'Garcia', notes })).toBeNull()
    }
  })

  it('keeps real names that merely contain a test-like substring', () => {
    // "Preston"/"Contessa" contain "test"-ish substrings but are not whole-token
    // matches, so they must NOT be flagged.
    expect(classifyTestOrSpamLead({ first_name: 'Preston', last_name: 'Baker' })).toBeNull()
    expect(classifyTestOrSpamLead({ first_name: 'Contessa', last_name: 'Webb' })).toBeNull()
    expect(classifyTestOrSpamLead({ first_name: 'Brandy', last_name: 'Ito' })).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(classifyTestOrSpamLead({})).toBeNull()
  })
})

describe('spamDisqualifiedReason', () => {
  it('gives distinct reasons per category', () => {
    expect(spamDisqualifiedReason('solicitation')).toMatch(/solicitation/i)
    expect(spamDisqualifiedReason('test_record')).toMatch(/test\/QA/i)
  })
})
