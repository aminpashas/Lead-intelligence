import { describe, it, expect } from 'vitest'
import {
  splitContactName,
  stageChanged,
  opportunityToIngestInput,
} from '@/lib/ghl/sync'
import type { GhlOpportunity } from '@/lib/ghl/types'

describe('splitContactName', () => {
  it('prefers structured first/last', () => {
    expect(splitContactName({ firstName: 'Ada', lastName: 'Lovelace' })).toEqual({
      first: 'Ada',
      last: 'Lovelace',
    })
  })
  it('falls back to splitting a full name', () => {
    expect(splitContactName({ name: 'Grace Brewster Hopper' })).toEqual({
      first: 'Grace',
      last: 'Brewster Hopper',
    })
  })
  it('handles a single token', () => {
    expect(splitContactName({ name: 'Cher' })).toEqual({ first: 'Cher', last: null })
  })
  it('handles null / empty', () => {
    expect(splitContactName(null)).toEqual({ first: 'Unknown', last: null })
    expect(splitContactName({})).toEqual({ first: 'Unknown', last: null })
  })
})

describe('stageChanged', () => {
  it('true when new stage differs', () => {
    expect(stageChanged('a', 'b')).toBe(true)
    expect(stageChanged(null, 'b')).toBe(true)
  })
  it('false when equal or new stage is null (unknown)', () => {
    expect(stageChanged('a', 'a')).toBe(false)
    expect(stageChanged('a', null)).toBe(false)
    expect(stageChanged(null, null)).toBe(false)
  })
})

describe('opportunityToIngestInput', () => {
  const opp: GhlOpportunity = {
    id: 'opp-123',
    pipelineStageId: 'g-stage',
    contact: { firstName: 'Sam', lastName: 'Lee', email: 'sam@x.com', phone: '4155551234' },
  }

  it('maps contact + opportunity into an ingest input with the correct external ref', () => {
    const input = opportunityToIngestInput(opp, opp.contact ?? null, {
      organizationId: 'org-1',
      stageId: 'li-stage',
      sourceName: 'GoHighLevel',
    })
    expect(input.organizationId).toBe('org-1')
    expect(input.firstName).toBe('Sam')
    expect(input.lastName).toBe('Lee')
    expect(input.email).toBe('sam@x.com')
    expect(input.phoneRaw).toBe('4155551234')
    expect(input.externalRef).toBe('ghl_opp:opp-123')
    expect(input.sourceType).toBe('ghl')
    expect(input.source).toBe('GoHighLevel')
    expect(input.stageId).toBe('li-stage')
    expect(input.tags).toEqual(['ghl'])
  })

  it('never grants consent — only carries the import source', () => {
    const input = opportunityToIngestInput(opp, opp.contact ?? null, {
      organizationId: 'org-1',
      stageId: null,
      sourceName: 'GoHighLevel',
    })
    expect(input.consent).toEqual({ source: 'ghl_import' })
    expect(input.consent?.sms).toBeUndefined()
    expect(input.consent?.email).toBeUndefined()
    expect(input.consent?.voice).toBeUndefined()
  })

  it('trims contact email/phone and tolerates a missing contact', () => {
    const input = opportunityToIngestInput({ id: 'o2' }, null, {
      organizationId: 'org-1',
      stageId: null,
      sourceName: 'GoHighLevel',
    })
    expect(input.firstName).toBe('Unknown')
    expect(input.email).toBeNull()
    expect(input.phoneRaw).toBeNull()
    expect(input.externalRef).toBe('ghl_opp:o2')
  })
})
