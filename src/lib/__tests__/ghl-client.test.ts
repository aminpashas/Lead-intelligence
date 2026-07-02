import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  assertGhlHost,
  contactNeedsFetch,
  ghlFetch,
  fetchPipelines,
  GHL_BASE,
  GHL_VERSION,
} from '@/lib/ghl/client'
import type { GhlConfig } from '@/lib/ghl/types'

const config: GhlConfig = {
  apiToken: 'pit-token',
  locationId: 'loc-1',
  pipelineId: null,
  baseUrl: GHL_BASE,
  version: GHL_VERSION,
  stageAuthority: 'li',
}

describe('assertGhlHost (SSRF guard)', () => {
  it('allows the canonical https host and subdomains', () => {
    expect(assertGhlHost('https://services.leadconnectorhq.com')).toContain('leadconnectorhq.com')
    expect(assertGhlHost('https://leadconnectorhq.com/x')).toContain('leadconnectorhq.com')
  })
  it('rejects http (no TLS)', () => {
    expect(() => assertGhlHost('http://services.leadconnectorhq.com')).toThrow(/Refusing/)
  })
  it('rejects a foreign host', () => {
    expect(() => assertGhlHost('https://evil.com')).toThrow(/Refusing/)
  })
  it('rejects a look-alike suffix host', () => {
    expect(() => assertGhlHost('https://services.leadconnectorhq.com.evil.com')).toThrow(/Refusing/)
  })
  it('rejects garbage', () => {
    expect(() => assertGhlHost('not a url')).toThrow(/Invalid/)
  })
})

describe('contactNeedsFetch', () => {
  it('false when inline contact has email', () => {
    expect(contactNeedsFetch({ id: 'o', contact: { email: 'a@b.com' } })).toBe(false)
  })
  it('false when inline contact has phone', () => {
    expect(contactNeedsFetch({ id: 'o', contact: { phone: '+1555' } })).toBe(false)
  })
  it('true when only a contactId is present', () => {
    expect(contactNeedsFetch({ id: 'o', contactId: 'c-1' })).toBe(true)
  })
  it('true when inline contact has an id but no email/phone', () => {
    expect(contactNeedsFetch({ id: 'o', contact: { id: 'c-2' } })).toBe(true)
  })
  it('false when there is nothing to fetch', () => {
    expect(contactNeedsFetch({ id: 'o' })).toBe(false)
  })
})

describe('ghlFetch / fetchPipelines', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends auth + version headers and encodes query', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ pipelines: [{ id: 'p1', name: 'Sales', stages: [] }] }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const pipelines = await fetchPipelines(config)

    expect(pipelines).toHaveLength(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
    expect(String(url)).toContain('/opportunities/pipelines')
    expect(String(url)).toContain('locationId=loc-1')
    expect(init.headers.Authorization).toBe('Bearer pit-token')
    expect(init.headers.Version).toBe(GHL_VERSION)
  })

  it('throws with status + path on a non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, text: async () => 'unauthorized' })),
    )
    await expect(ghlFetch(config, '/opportunities/pipelines')).rejects.toThrow(/GHL 401/)
  })

  it('retries once on 429 then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'slow down' })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ pipelines: [] }) })
    vi.stubGlobal('fetch', fetchMock)

    const pipelines = await fetchPipelines(config)
    expect(pipelines).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
