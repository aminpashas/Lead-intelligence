import { describe, it, expect, vi } from 'vitest'

// Deterministic hashing + passthrough encryption so we can assert the raw
// insert payload. Real consent + phone logic are kept (not mocked).
vi.mock('@/lib/encryption', () => ({
  searchHash: (v: string | null | undefined) =>
    v == null || v === '' ? null : `hash_${String(v).toLowerCase().trim()}`,
  encryptLeadPII: <T>(d: T) => d,
}))
vi.mock('@/lib/hipaa-audit', () => ({ auditPHIWrite: vi.fn(async () => {}) }))

import { buildLeadInsert, ingestLead, type IngestInput } from '@/lib/leads/ingest'

const NOW = '2026-06-30T12:00:00.000Z'

describe('buildLeadInsert (pure payload shaping)', () => {
  // Regression: every GHL/bridge importer splits a nameless contact's phone into
  // the name columns, so leads landed named "(925) 497-0821" and AI SMS opened
  // with "Hi (925),". The guard belongs here because this is the one path every
  // importer shares. See phone-name.ts.
  it('scrubs a phone number parsed into the name columns, and tags the lead', () => {
    const row = buildLeadInsert(
      { organizationId: 'o', firstName: '(925)', lastName: '497-0821', phoneRaw: '9254970821' },
      { sourceId: null, stageId: 'stage-1', now: NOW },
    )
    // '' not null: leads.first_name is NOT NULL, so the scrub writes an empty
    // string. Writing null here throws 23502 on real ingest — the mocked
    // encryption in these tests cannot see that constraint, so assert it.
    expect(row.first_name).toBe('')
    expect(row.last_name).toBeNull()
    expect(row.tags).toEqual(['name-unknown'])
    // The lead itself survives — it is a real prospect, just a nameless one.
    expect(row.phone).toBe('9254970821')
    expect(row.phone_formatted).toBe('+19254970821')
  })

  it('keeps a real name beside a stray phone, and leaves ordinary names alone', () => {
    const stray = buildLeadInsert(
      { organizationId: 'o', firstName: 'chris', lastName: '606-2595' },
      { sourceId: null, stageId: null, now: NOW },
    )
    expect(stray.first_name).toBe('chris')
    expect(stray.last_name).toBeNull()

    const ordinary = buildLeadInsert(
      { organizationId: 'o', firstName: 'Ada', lastName: 'Lovelace', tags: ['ghl'] },
      { sourceId: null, stageId: null, now: NOW },
    )
    expect(ordinary.first_name).toBe('Ada')
    expect(ordinary.last_name).toBe('Lovelace')
    expect(ordinary.tags).toEqual(['ghl']) // untouched — no spurious tag
  })

  it('defaults consent to UNKNOWN — never writes a boolean the gate could allow', () => {
    const row = buildLeadInsert(
      { organizationId: 'o', firstName: 'Jane', email: 'jane@x.com', consent: { source: 'ghl_import' } },
      { sourceId: null, stageId: 'stage-1', now: NOW },
    )
    expect(row.sms_consent_status).toBe('unknown')
    expect(row.email_consent_status).toBe('unknown')
    expect(row.voice_consent_status).toBe('unknown')
    expect(row.sms_consent).toBeUndefined()
    expect(row.email_consent).toBeUndefined()
    expect(row.voice_consent).toBeUndefined()
    expect(row.stage_id).toBe('stage-1')
    expect(row.organization_id).toBe('o')
  })

  it('formats the phone to E.164 and trims the email', () => {
    const row = buildLeadInsert(
      { organizationId: 'o', firstName: 'A', email: '  a@b.com ', phoneRaw: '4155551234' },
      { sourceId: null, stageId: null, now: NOW },
    )
    expect(row.email).toBe('a@b.com')
    expect(row.phone).toBe('4155551234')
    expect(row.phone_formatted).toBe('+14155551234')
    // no stage override → stage_id omitted (falls back to default at the DB layer)
    expect('stage_id' in row).toBe(false)
  })

  it('carries external_ref, tags, status, source_type, and utm when present', () => {
    const row = buildLeadInsert(
      {
        organizationId: 'o',
        firstName: 'A',
        sourceType: 'ghl',
        externalRef: 'ghl_opp:abc',
        tags: ['ghl'],
        status: 'contacted',
        utm_source: 'newsletter',
      },
      { sourceId: 's1', stageId: null, now: NOW },
    )
    expect(row.external_ref).toBe('ghl_opp:abc')
    expect(row.tags).toEqual(['ghl'])
    expect(row.status).toBe('contacted')
    expect(row.source_type).toBe('ghl')
    expect(row.source_id).toBe('s1')
    expect(row.utm_source).toBe('newsletter')
  })

  it('stamps consent only on an explicit grant', () => {
    const row = buildLeadInsert(
      { organizationId: 'o', firstName: 'A', consent: { sms: true, source: 'optin' } },
      { sourceId: null, stageId: null, now: NOW },
    )
    expect(row.sms_consent_status).toBe('granted')
    expect(row.sms_consent).toBe(true)
    expect(row.sms_consent_at).toBe(NOW)
    expect(row.sms_consent_source).toBe('optin')
    // other channels remain unknown
    expect(row.email_consent_status).toBe('unknown')
  })
})

// ── Mock supabase for ingestLead I/O ─────────────────────────────────
function mockSupabase(opts: {
  existing?: Array<{ id: string; email_hash: string | null; phone_hash: string | null }>
  insertedId?: string
}) {
  const existing = opts.existing ?? []
  const insertedId = opts.insertedId ?? 'lead-new'
  const captured = {
    leadInsert: null as Record<string, unknown> | null,
    updates: [] as Array<{ table: string; vals: Record<string, unknown> }>,
  }

  function builder(table: string) {
    let op: 'select' | 'insert' | 'update' = 'select'
    const chain: Record<string, unknown> = {}
    const ret = () => chain
    chain.select = vi.fn(ret)
    chain.eq = vi.fn(ret)
    chain.in = vi.fn(ret)
    chain.or = vi.fn(ret)
    chain.is = vi.fn(ret)
    chain.ilike = vi.fn(ret)
    chain.limit = vi.fn(ret)
    chain.insert = vi.fn((rows: Record<string, unknown>) => {
      op = 'insert'
      if (table === 'leads') captured.leadInsert = rows
      return chain
    })
    chain.update = vi.fn((vals: Record<string, unknown>) => {
      op = 'update'
      captured.updates.push({ table, vals })
      return chain
    })
    const resolveSingle = () => {
      if (table === 'leads' && op === 'insert') return { data: { id: insertedId }, error: null }
      return { data: null, error: null }
    }
    chain.maybeSingle = vi.fn(async () => resolveSingle())
    chain.single = vi.fn(async () => resolveSingle())
    chain.then = (resolve: (v: unknown) => void) => {
      if (table === 'leads' && op === 'select') return resolve({ data: existing, error: null })
      return resolve({ data: null, error: null })
    }
    return chain
  }

  return { api: { from: vi.fn((t: string) => builder(t)) } as never, captured }
}

describe('ingestLead', () => {
  it('inserts a new lead with consent unknown and the external ref', async () => {
    const { api, captured } = mockSupabase({ insertedId: 'lead-42' })
    const input: IngestInput = {
      organizationId: 'org-1',
      firstName: 'Sam',
      email: 'sam@x.com',
      sourceType: 'ghl',
      externalRef: 'ghl_opp:opp-1',
      tags: ['ghl'],
      stageId: 'li-stage',
      consent: { source: 'ghl_import' },
    }
    const res = await ingestLead(api, input, { caller: 'ghl-sync', armSpeedToLead: false })

    expect(res.deduplicated).toBe(false)
    expect(res.id).toBe('lead-42')
    expect(captured.leadInsert?.sms_consent_status).toBe('unknown')
    expect(captured.leadInsert?.sms_consent).toBeUndefined()
    expect(captured.leadInsert?.external_ref).toBe('ghl_opp:opp-1')
    expect(captured.leadInsert?.stage_id).toBe('li-stage')
    expect(captured.leadInsert?.source_type).toBe('ghl')
  })

  it('returns the existing lead on a dedup hit and backfills external_ref', async () => {
    const { api, captured } = mockSupabase({
      existing: [{ id: 'existing-1', email_hash: 'hash_sam@x.com', phone_hash: null }],
    })
    const res = await ingestLead(
      api,
      {
        organizationId: 'org-1',
        firstName: 'Sam',
        email: 'sam@x.com',
        externalRef: 'ghl_opp:opp-1',
        consent: { source: 'ghl_import' },
      },
      { caller: 'ghl-sync' },
    )

    expect(res.deduplicated).toBe(true)
    expect(res.id).toBe('existing-1')
    expect(captured.leadInsert).toBeNull() // never inserted
    const backfill = captured.updates.find((u) => u.table === 'leads')
    expect(backfill?.vals.external_ref).toBe('ghl_opp:opp-1')
  })
})
