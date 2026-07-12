/**
 * Workstream B2: widened enrichment persistence tests.
 *
 * Verifies that provider payloads land in lead_enrichment.enrichment_attributes
 * as namespaced keys (email.*, phone.*, geo.*, ads.*, web.*, experian.*), that
 * Experian updates the typed marketing columns on leads, and that providers
 * without configured keys leave enrichment_attributes untouched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Lead } from '@/types/database'
import { enrichLead, buildEnrichmentAttributes } from '../index'
import {
  enrichWithExperian,
  experianAttributesFromVars,
  experianLeadColumns,
} from '../experian-consumer'
import type { EnrichmentConfig } from '../types'

// ── Mock Supabase ──────────────────────────────────────────

type Recorded = { table: string; payload: Record<string, unknown> }

function createMockSupabase() {
  const inserts: Recorded[] = []
  const updates: Recorded[] = []

  function builder(table: string) {
    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['select', 'eq', 'in', 'or', 'gt', 'gte', 'lt', 'lte', 'order', 'limit']) {
      b[m] = chain
    }
    b.insert = (payload: Record<string, unknown>) => {
      inserts.push({ table, payload })
      return b
    }
    b.update = (payload: Record<string, unknown>) => {
      updates.push({ table, payload })
      return b
    }
    b.single = () => Promise.resolve({ data: null, error: null })
    // Thenable: any awaited chain resolves to an empty result set.
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject)
    return b
  }

  const client = { from: (table: string) => builder(table) }
  return { client: client as unknown as SupabaseClient, inserts, updates }
}

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'lead-1',
    organization_id: 'org-1',
    first_name: 'Pat',
    last_name: 'Doe',
    email: 'pat@example.com',
    phone: null,
    city: 'San Francisco',
    state: 'CA',
    zip_code: '94108',
    custom_fields: {},
    ...overrides,
  } as unknown as Lead
}

const allDisabled: Partial<EnrichmentConfig> = {
  email_validation: { enabled: false },
  phone_validation: { enabled: false },
  ip_geolocation: { enabled: false },
  google_ads_keyword: { enabled: false },
  website_behavior: { enabled: false },
  credit_prequal: { enabled: false },
  experian_consumer: { enabled: false },
}

// ── Env isolation ──────────────────────────────────────────

const ENV_KEYS = [
  'ZEROBOUNCE_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'EXPERIAN_CLIENT_ID',
  'EXPERIAN_CLIENT_SECRET',
  'EXPERIAN_USERNAME',
  'EXPERIAN_PASSWORD',
]
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  vi.unstubAllGlobals()
})

// ── Unit: experian attribute extraction ────────────────────

describe('experianAttributesFromVars', () => {
  it('namespaces the full vars payload with snake_case keys, skipping nulls', () => {
    const attrs = experianAttributesFromVars({
      mosaicGroup: 'A01',
      HOUSEHOLD_INCOME_CODE: 'G',
      lengthOfResidence: 12,
      childrenPresent: false,
      emptyString: '  ',
      missing: null,
      alsoMissing: undefined,
      anArray: ['x', 'y'],
      nestedGroup: { INNER_CODE: 'X1', deep: { tooDeep: 'skipped-at-depth-3' } },
    })

    expect(attrs['experian.mosaic_group']).toBe('A01')
    expect(attrs['experian.household_income_code']).toBe('G')
    expect(attrs['experian.length_of_residence']).toBe('12')
    expect(attrs['experian.children_present']).toBe('false')
    // one-level group flattening
    expect(attrs['experian.inner_code']).toBe('X1')
    expect(attrs['experian.too_deep']).toBe('skipped-at-depth-3')
    // skipped values
    expect(Object.keys(attrs).some((k) => k.includes('empty_string'))).toBe(false)
    expect(Object.keys(attrs).some((k) => k.includes('missing'))).toBe(false)
    expect(Object.keys(attrs).some((k) => k.includes('an_array'))).toBe(false)
    // every key is namespaced
    for (const key of Object.keys(attrs)) expect(key.startsWith('experian.')).toBe(true)
  })
})

describe('experianLeadColumns', () => {
  it('derives the typed marketing columns and omits unknowns', () => {
    const cols = experianLeadColumns({
      estimated_income_range: { min: 75000, max: 100000 },
      home_value_range: { min: 400000, max: 500000 },
      homeowner: true,
      mosaic_group: 'A01',
      mosaic_type: null,
    } as Parameters<typeof experianLeadColumns>[0])

    expect(cols).toEqual({
      household_income_band: '75000-100000',
      homeowner_status: 'homeowner',
      home_value_band: '400000-500000',
      mosaic_segment: 'A01',
    })
  })

  it('returns an empty object when nothing is known', () => {
    const cols = experianLeadColumns({
      estimated_income_range: null,
      home_value_range: null,
      homeowner: null,
      mosaic_group: null,
      mosaic_type: null,
    } as Parameters<typeof experianLeadColumns>[0])
    expect(cols).toEqual({})
  })
})

// ── Unit: per-provider namespacing ─────────────────────────

describe('buildEnrichmentAttributes', () => {
  it('namespaces email validation payloads under email.*', () => {
    const attrs = buildEnrichmentAttributes('email_validation', {
      status: 'valid',
      sub_status: null,
      free_email: false,
      disposable: false,
      domain: 'example.com',
      domain_age_days: 5000,
      smtp_provider: 'google',
      mx_found: true,
      did_you_mean: null,
    })
    expect(attrs).toEqual({
      'email.status': 'valid',
      'email.free_email': false,
      'email.disposable': false,
      'email.domain': 'example.com',
      'email.domain_age_days': 5000,
      'email.smtp_provider': 'google',
      'email.mx_found': true,
    })
  })

  it('namespaces phone, geo, ads and web payloads', () => {
    expect(
      buildEnrichmentAttributes('phone_validation', {
        valid: true, line_type: 'mobile', carrier: 'Verizon', caller_name: null,
        country_code: 'US', national_format: '(415) 555-0100',
      })
    ).toMatchObject({ 'phone.valid': true, 'phone.line_type': 'mobile', 'phone.carrier': 'Verizon' })

    expect(
      buildEnrichmentAttributes('ip_geolocation', {
        ip: '1.2.3.4', city: 'Oakland', region: 'CA', country: 'US', postal_code: null,
        latitude: 37.8, longitude: -122.27, timezone: 'America/Los_Angeles', isp: 'Comcast',
        is_proxy: false, is_vpn: false, distance_to_practice_miles: 11.4,
      })
    ).toMatchObject({ 'geo.city': 'Oakland', 'geo.distance_to_practice_miles': 11.4, 'geo.is_proxy': false })

    expect(
      buildEnrichmentAttributes('google_ads_keyword', {
        campaign_name: 'TMJ Search', ad_group_name: null, keyword: 'tmj specialist',
        match_type: 'phrase', device: 'mobile',
      })
    ).toMatchObject({ 'ads.campaign_name': 'TMJ Search', 'ads.keyword': 'tmj specialist' })

    expect(
      buildEnrichmentAttributes('website_behavior', {
        pages_visited: ['/pricing', '/financing'], time_on_site_seconds: 300,
        pricing_page_viewed: true, financing_page_viewed: true, testimonials_viewed: false,
        before_after_viewed: false, device_type: 'mobile', browser: 'Safari',
        session_count: 2, form_time_seconds: null,
      })
    ).toMatchObject({
      'web.pages_visited': JSON.stringify(['/pricing', '/financing']),
      'web.time_on_site_seconds': 300,
      'web.pricing_page_viewed': true,
      'web.session_count': 2,
    })
  })

  it('keeps credit_prequal OUT of the marketing attribute store (FCRA hygiene)', () => {
    const attrs = buildEnrichmentAttributes('credit_prequal', {
      overall_approval_likelihood: 80,
      recommended_lender: 'sunbit',
    })
    expect(attrs).toEqual({})
  })
})

// ── Integration: enrichLead persistence ────────────────────

describe('enrichLead persistence', () => {
  it('stores namespaced enrichment_attributes on the lead_enrichment row', async () => {
    const { client, inserts } = createMockSupabase()
    const lead = makeLead()

    await enrichLead(client, lead, { ...allDisabled, email_validation: { enabled: true } })

    const rows = inserts.filter((i) => i.table === 'lead_enrichment')
    expect(rows).toHaveLength(1)
    const row = rows[0].payload
    expect(row.enrichment_type).toBe('email_validation')
    const attrs = row.enrichment_attributes as Record<string, unknown>
    // No ZeroBounce key configured → provider returns its fallback payload,
    // which still persists as namespaced operational attributes.
    expect(attrs['email.status']).toBe('unknown')
    expect(attrs['email.sub_status']).toBe('api_key_not_configured')
    expect(attrs['email.domain']).toBe('example.com')
    // null payload fields are skipped
    expect('email.did_you_mean' in attrs).toBe(false)
  })

  it('runs Experian, persists experian.* attributes and updates typed lead columns', async () => {
    process.env.EXPERIAN_CLIENT_ID = 'test-client'
    process.env.EXPERIAN_CLIENT_SECRET = 'test-secret'

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.includes('/oauth2/')) {
        return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 1800 }) }
      }
      return {
        ok: true,
        json: async () => ({
          variables: {
            estimatedIncome: 'G',
            FSS_CODE: 'B1',
            mosaicGroup: 'A01',
            homeowner: 'Y',
            HOME_VALUE_CODE: 'H',
            exactAge: 54,
            maritalStatus: 'M',
            matchLevel: 'HIGH',
            dataDate: '2026-05',
            nullVar: null,
          },
        }),
      }
    }))

    const { client, inserts, updates } = createMockSupabase()
    // Unique name per test: enrichWithExperian memoizes by input identity.
    const lead = makeLead({ first_name: 'Experia', last_name: 'FullFlow' } as Partial<Lead>)

    await enrichLead(client, lead, { ...allDisabled, experian_consumer: { enabled: true } })

    const rows = inserts.filter((i) => i.table === 'lead_enrichment')
    expect(rows).toHaveLength(1)
    const row = rows[0].payload
    expect(row.enrichment_type).toBe('experian_consumer')
    expect(row.status).toBe('success')

    const attrs = row.enrichment_attributes as Record<string, unknown>
    expect(attrs['experian.estimated_income']).toBe('G')
    expect(attrs['experian.fss_code']).toBe('B1')
    expect(attrs['experian.mosaic_group']).toBe('A01')
    expect(attrs['experian.match_level']).toBe('HIGH')
    expect(Object.keys(attrs).some((k) => k.includes('null_var'))).toBe(false)

    // Typed marketing columns land on the leads update
    const leadUpdate = updates.find((u) => u.table === 'leads')?.payload as Record<string, unknown>
    expect(leadUpdate.household_income_band).toBe('75000-100000')
    expect(leadUpdate.homeowner_status).toBe('homeowner')
    expect(leadUpdate.home_value_band).toBe('400000-500000')
    expect(leadUpdate.mosaic_segment).toBe('A01')
  })

  it('leaves enrichment_attributes untouched when the provider key is not set', async () => {
    // No EXPERIAN_CLIENT_ID → the provider never queues, no row is written,
    // and the leads update carries no experian-derived columns.
    const { client, inserts, updates } = createMockSupabase()
    const lead = makeLead({ first_name: 'NoKey' } as Partial<Lead>)

    await enrichLead(client, lead, { ...allDisabled, experian_consumer: { enabled: true } })

    expect(inserts.filter((i) => i.table === 'lead_enrichment')).toHaveLength(0)

    const leadUpdate = updates.find((u) => u.table === 'leads')?.payload as Record<string, unknown>
    expect(leadUpdate).toBeDefined()
    for (const col of ['household_income_band', 'homeowner_status', 'home_value_band', 'mosaic_segment']) {
      expect(col in leadUpdate).toBe(false)
    }
  })

  it('fallback Experian result (no key) carries an empty attribute map', async () => {
    const result = await enrichWithExperian({
      first_name: 'Pat', last_name: 'Doe', zip_code: '94108',
    })
    expect(result.match_confidence).toBe(0)
    expect(result.attributes).toEqual({})
    expect(buildEnrichmentAttributes('experian_consumer', result as unknown as Record<string, unknown>)).toEqual({})
  })
})
