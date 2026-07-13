import { describe, it, expect, vi, afterEach } from 'vitest'
import { fanOutToCrons, summarizeFanOut } from '../fan-out'

/** Minimal NextRequest stand-in: fan-out only reads headers. */
function reqWith(headers: Record<string, string>) {
  return { headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } } as unknown as import('next/server').NextRequest
}

const OLD_ENV = { ...process.env }
afterEach(() => {
  process.env = { ...OLD_ENV }
  vi.restoreAllMocks()
})

describe('fanOutToCrons', () => {
  it('POSTs each target on the forwarded host with the CRON_SECRET', async () => {
    process.env.CRON_SECRET = 's3cret'
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const req = reqWith({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'app.example.com' })
    const results = await fanOutToCrons(req, ['enrich', 'voice-reconcile'])

    expect(fetchMock).toHaveBeenCalledWith('https://app.example.com/api/cron/enrich', {
      method: 'POST',
      headers: { authorization: 'Bearer s3cret' },
    })
    expect(fetchMock).toHaveBeenCalledWith('https://app.example.com/api/cron/voice-reconcile', expect.anything())
    expect(results.every((r) => r.ok)).toBe(true)
  })

  it('captures a failing target without sinking the batch', async () => {
    process.env.CRON_SECRET = 's3cret'
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
      .mockRejectedValueOnce(new Error('boom'))
    vi.stubGlobal('fetch', fetchMock)

    const results = await fanOutToCrons(reqWith({ host: 'x.co' }), ['a', 'b'])
    expect(results[0]).toMatchObject({ cron: 'a', ok: true })
    expect(results[1]).toMatchObject({ cron: 'b', ok: false, error: 'boom' })
  })

  it('throws if CRON_SECRET is missing (fail-closed)', async () => {
    delete process.env.CRON_SECRET
    await expect(fanOutToCrons(reqWith({ host: 'x.co' }), ['a'])).rejects.toThrow(/CRON_SECRET/)
  })
})

describe('summarizeFanOut', () => {
  it('is ok when all succeed', () => {
    const out = summarizeFanOut([
      { cron: 'a', ok: true, status: 200 },
      { cron: 'b', ok: true, status: 200 },
    ])
    expect(out).toMatchObject({ status: 'ok', items: 2, error: undefined })
  })

  it('is failed and names the offenders when any fail', () => {
    const out = summarizeFanOut([
      { cron: 'a', ok: true, status: 200 },
      { cron: 'b', ok: false, status: 500 },
    ])
    expect(out.status).toBe('failed')
    expect(out.items).toBe(1)
    expect(out.error).toContain('b(500)')
  })
})
