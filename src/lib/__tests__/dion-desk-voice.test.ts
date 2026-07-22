/**
 * Voice-transcript hand-off to Dion Desk, riding the shared dion_desk_outbox.
 *
 * The contact path (comms.contact_identified) and the voice path
 * (comms.voice_transcript) share one outbox and one drain cron but land on two
 * different Desk routes with two different secrets — these tests pin that routing
 * so a future change can't silently post a transcript at the bus (wrong secret,
 * 401, retries until MAX_ATTEMPTS) or a contact event at the voice ingest.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { enqueueDeskVoiceTranscript, forwardDeskOutbox } from '@/lib/bridges/dion-desk'

const CALL = {
  organizationId: 'org-1',
  callId: 'call-1',
  leadId: 'lead-1',
  patientNumber: '+16692690542',
  practiceNumber: '+14158861942',
  transcript: 'Agent: Hi Lawrence.\nUser: My denture broke.',
  direction: 'inbound' as const,
  twilioCallSid: 'CA123',
}

/** Minimal supabase stub: records upserts, serves rows to the drain loop. */
function makeSupabase(pendingRows: Record<string, unknown>[] = []) {
  const upserts: Record<string, unknown>[] = []
  const updates: Record<string, unknown>[] = []
  const client = {
    from() {
      const qb: Record<string, unknown> = {
        upsert(row: Record<string, unknown>) {
          upserts.push(row)
          return Promise.resolve({ error: null })
        },
        update(patch: Record<string, unknown>) {
          updates.push(patch)
          return { eq: () => Promise.resolve({ error: null }) }
        },
        select: () => qb,
        neq: () => qb,
        lt: () => qb,
        order: () => qb,
        limit: () => Promise.resolve({ data: pendingRows, error: null }),
      }
      return qb
    },
  }
  return { client: client as never, upserts, updates }
}

describe('enqueueDeskVoiceTranscript', () => {
  it('buffers the transcript keyed on the call, so both finalization paths dedupe', async () => {
    const { client, upserts } = makeSupabase()
    await enqueueDeskVoiceTranscript(client, CALL)

    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({
      organization_id: 'org-1',
      lead_id: 'lead-1',
      event_type: 'comms.voice_transcript',
      idempotency_key: 'call-1:comms.voice_transcript',
    })
    expect(upserts[0].payload).toMatchObject({
      from: CALL.patientNumber,
      calledNumber: CALL.practiceNumber,
      direction: 'inbound',
      callSid: 'CA123',
    })
  })

  it('skips what Desk cannot act on rather than queuing a row that will 4xx', async () => {
    for (const bad of [
      { ...CALL, transcript: '   ' },
      { ...CALL, patientNumber: null },
      // Desk fails closed (422) with no dialed number to map to an account.
      { ...CALL, practiceNumber: null },
    ]) {
      const { client, upserts } = makeSupabase()
      await enqueueDeskVoiceTranscript(client, bad)
      expect(upserts).toHaveLength(0)
    }
  })
})

describe('forwardDeskOutbox — voice routing', () => {
  const voiceRow = {
    id: 'row-1',
    organization_id: 'org-1',
    lead_id: 'lead-1',
    patient_id: null,
    attempts: 0,
    idempotency_key: 'call-1:comms.voice_transcript',
    event_type: 'comms.voice_transcript',
    payload: {
      from: CALL.patientNumber,
      calledNumber: CALL.practiceNumber,
      transcript: CALL.transcript,
      direction: 'inbound',
      callSid: 'CA123',
    },
  }

  beforeEach(() => {
    process.env.DION_DESK_URL = 'https://dion-desk.example'
    process.env.DION_BUS_SECRET = 'bus-secret'
    process.env.DION_DESK_RELAY_SECRET = 'relay-secret'
    vi.restoreAllMocks()
  })
  afterEach(() => {
    delete process.env.DION_DESK_URL
    delete process.env.DION_BUS_SECRET
    delete process.env.DION_DESK_RELAY_SECRET
  })

  it('posts voice rows to /api/ingest/voice with the relay token, not the bus secret', async () => {
    const { client } = makeSupabase([voiceRow])
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }))

    const result = await forwardDeskOutbox(client, { limit: 10 })
    expect(result.sent).toBe(1)

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://dion-desk.example/api/ingest/voice')
    const headers = init.headers as Record<string, string>
    expect(headers['x-relay-token']).toBe('relay-secret')
    expect(headers['x-forward-secret']).toBeUndefined()

    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ from: CALL.patientNumber, calledNumber: CALL.practiceNumber })
    // Desk meters these into its own ledger; ours are Retell's and already metered.
    expect(body).not.toHaveProperty('durationSeconds')
    expect(body).not.toHaveProperty('usage')
  })

  it('keeps a row pending when the relay secret is missing, instead of burning retries', async () => {
    delete process.env.DION_DESK_RELAY_SECRET
    const { client, updates } = makeSupabase([voiceRow])
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const result = await forwardDeskOutbox(client, { limit: 10 })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.failed).toBe(1)
    expect(updates[0]).toMatchObject({ status: 'pending', attempts: 1 })
    expect(String(updates[0].last_error)).toContain('DION_DESK_RELAY_SECRET')
  })

  it('retries a Desk 5xx and retires the row only at the attempt ceiling', async () => {
    const { client, updates } = makeSupabase([{ ...voiceRow, attempts: 7 }])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 503 }))

    await forwardDeskOutbox(client, { limit: 10 })
    // MAX_ATTEMPTS is 8, so attempt 8 is the last one.
    expect(updates[0]).toMatchObject({ status: 'failed', attempts: 8 })
    expect(String(updates[0].last_error)).toContain('503')
  })

  it('is a no-op while Desk is unprovisioned', async () => {
    delete process.env.DION_DESK_URL
    const { client } = makeSupabase([voiceRow])
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    expect(await forwardDeskOutbox(client)).toMatchObject({ skipped: true })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
