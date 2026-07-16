import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  assertConsent,
  logConsentViolation,
  isEligibleForConsentCapture,
  type ConsentChannel,
} from '@/lib/consent/gate'

// ── Supabase mock helpers ────────────────────────────────────────

function makeLeadData(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lead-1',
    organization_id: 'org-1',
    sms_consent: null,
    sms_opt_out: null,
    email_consent: null,
    email_opt_out: null,
    voice_consent: null,
    voice_opt_out: null,
    do_not_call: null,
    sms_consent_status: 'unknown',
    email_consent_status: 'unknown',
    voice_consent_status: 'unknown',
    ...overrides,
  }
}

function createMockSupabase(lead: Record<string, unknown> | null, error: unknown = null) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: lead, error }),
  }
  const insertChain = {
    insert: vi.fn().mockResolvedValue({ error: null }),
  }
  return {
    from: vi.fn((table: string) => {
      if (table === 'events') return insertChain
      return chain
    }),
    _leadChain: chain,
    _insertChain: insertChain,
  }
}

describe('assertConsent', () => {
  // ── SMS Channel ──────────────────────────────────────────

  describe('sms channel', () => {
    it('allows when sms_consent is true and not opted out', async () => {
      const supabase = createMockSupabase(makeLeadData({ sms_consent: true, sms_opt_out: false }))
      const result = await assertConsent(supabase as any, 'lead-1', 'sms')

      expect(result.allowed).toBe(true)
      if (result.allowed) {
        expect(result.lead.id).toBe('lead-1')
      }
    })

    it('denies with opted_out when sms_opt_out is true', async () => {
      const supabase = createMockSupabase(makeLeadData({ sms_consent: true, sms_opt_out: true }))
      const result = await assertConsent(supabase as any, 'lead-1', 'sms')

      expect(result.allowed).toBe(false)
      if (!result.allowed) {
        expect(result.reason).toBe('opted_out')
      }
    })

    it('allows (consent assumed) when sms_consent is unknown and not opted out', async () => {
      const supabase = createMockSupabase(makeLeadData({ sms_consent: null, sms_opt_out: false }))
      const result = await assertConsent(supabase as any, 'lead-1', 'sms')

      expect(result.allowed).toBe(true)
    })

    it('allows (consent assumed) when sms_consent is false but not opted out', async () => {
      const supabase = createMockSupabase(makeLeadData({ sms_consent: false }))
      const result = await assertConsent(supabase as any, 'lead-1', 'sms')

      expect(result.allowed).toBe(true)
    })

    it('opt_out takes priority over consent', async () => {
      const supabase = createMockSupabase(makeLeadData({ sms_consent: true, sms_opt_out: true }))
      const result = await assertConsent(supabase as any, 'lead-1', 'sms')

      expect(result.allowed).toBe(false)
      if (!result.allowed) {
        expect(result.reason).toBe('opted_out')
      }
    })
  })

  // ── Email Channel ────────────────────────────────────────

  describe('email channel', () => {
    it('allows when email_consent is true and not opted out', async () => {
      const supabase = createMockSupabase(makeLeadData({ email_consent: true, email_opt_out: false }))
      const result = await assertConsent(supabase as any, 'lead-1', 'email')

      expect(result.allowed).toBe(true)
    })

    it('denies with opted_out when email_opt_out is true', async () => {
      const supabase = createMockSupabase(makeLeadData({ email_consent: true, email_opt_out: true }))
      const result = await assertConsent(supabase as any, 'lead-1', 'email')

      expect(result.allowed).toBe(false)
      if (!result.allowed) {
        expect(result.reason).toBe('opted_out')
      }
    })

    it('allows (consent assumed) when email_consent is null but not opted out', async () => {
      const supabase = createMockSupabase(makeLeadData({ email_consent: null }))
      const result = await assertConsent(supabase as any, 'lead-1', 'email')

      expect(result.allowed).toBe(true)
    })
  })

  // ── Voice Channel ────────────────────────────────────────

  describe('voice channel', () => {
    it('allows when voice_consent is true, not opted out, not DNC', async () => {
      const supabase = createMockSupabase(makeLeadData({
        voice_consent: true,
        voice_opt_out: false,
        do_not_call: false,
      }))
      const result = await assertConsent(supabase as any, 'lead-1', 'voice')

      expect(result.allowed).toBe(true)
    })

    it('denies with do_not_call even when voice_consent is true', async () => {
      const supabase = createMockSupabase(makeLeadData({
        voice_consent: true,
        voice_opt_out: false,
        do_not_call: true,
      }))
      const result = await assertConsent(supabase as any, 'lead-1', 'voice')

      expect(result.allowed).toBe(false)
      if (!result.allowed) {
        expect(result.reason).toBe('do_not_call')
      }
    })

    it('do_not_call takes priority over opt_out', async () => {
      const supabase = createMockSupabase(makeLeadData({
        voice_consent: true,
        voice_opt_out: true,
        do_not_call: true,
      }))
      const result = await assertConsent(supabase as any, 'lead-1', 'voice')

      expect(result.allowed).toBe(false)
      if (!result.allowed) {
        expect(result.reason).toBe('do_not_call')
      }
    })

    it('denies with opted_out when voice_opt_out is true (no DNC)', async () => {
      const supabase = createMockSupabase(makeLeadData({
        voice_consent: true,
        voice_opt_out: true,
        do_not_call: false,
      }))
      const result = await assertConsent(supabase as any, 'lead-1', 'voice')

      expect(result.allowed).toBe(false)
      if (!result.allowed) {
        expect(result.reason).toBe('opted_out')
      }
    })

    it('allows (consent assumed) when voice_consent is null but not opted out or DNC', async () => {
      const supabase = createMockSupabase(makeLeadData({
        voice_consent: null,
        voice_opt_out: false,
        do_not_call: false,
      }))
      const result = await assertConsent(supabase as any, 'lead-1', 'voice')

      expect(result.allowed).toBe(true)
    })
  })

  // ── Error Cases ──────────────────────────────────────────

  describe('error handling', () => {
    it('returns lead_not_found when no lead exists', async () => {
      const supabase = createMockSupabase(null)
      const result = await assertConsent(supabase as any, 'nonexistent', 'sms')

      expect(result.allowed).toBe(false)
      if (!result.allowed) {
        expect(result.reason).toBe('lead_not_found')
        expect(result.lead).toBeNull()
      }
    })

    it('returns lookup_failed when Supabase returns an error with data', async () => {
      // When error exists AND lead exists, it's a lookup_failed
      const supabase = createMockSupabase(
        makeLeadData(),
        { message: 'DB error' }
      )
      const result = await assertConsent(supabase as any, 'lead-1', 'sms')

      expect(result.allowed).toBe(false)
      if (!result.allowed) {
        expect(result.reason).toBe('lookup_failed')
      }
    })
  })
})

describe('logConsentViolation', () => {
  it('inserts an event record with correct structure', async () => {
    const supabase = createMockSupabase(null)
    await logConsentViolation(supabase as any, {
      organizationId: 'org-1',
      leadId: 'lead-1',
      channel: 'sms',
      reason: 'opted_out',
      bodyPreview: 'Hey there! Schedule your appointment...',
      caller: 'sendSMSToLead',
    })

    expect(supabase._insertChain.insert).toHaveBeenCalledWith({
      organization_id: 'org-1',
      lead_id: 'lead-1',
      event_type: 'consent_violation_prevented',
      payload: {
        channel: 'sms',
        reason: 'opted_out',
        caller: 'sendSMSToLead',
        body_preview: 'Hey there! Schedule your appointment...',
      },
      capi_status: 'na',
      gads_status: 'na',
    })
  })

  it('truncates body_preview to 100 characters', async () => {
    const supabase = createMockSupabase(null)
    const longBody = 'x'.repeat(200)

    await logConsentViolation(supabase as any, {
      organizationId: 'org-1',
      leadId: 'lead-1',
      channel: 'email',
      reason: 'no_consent',
      bodyPreview: longBody,
    })

    const insertCall = supabase._insertChain.insert.mock.calls[0][0]
    expect(insertCall.payload.body_preview).toHaveLength(100)
  })

  it('sets caller to null when not provided', async () => {
    const supabase = createMockSupabase(null)
    await logConsentViolation(supabase as any, {
      organizationId: 'org-1',
      leadId: 'lead-1',
      channel: 'voice',
      reason: 'do_not_call',
    })

    const insertCall = supabase._insertChain.insert.mock.calls[0][0]
    expect(insertCall.payload.caller).toBeNull()
    expect(insertCall.payload.body_preview).toBeNull()
  })

  it('never throws even when insert fails', async () => {
    const supabase = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockRejectedValue(new Error('DB is down')),
      }),
    }

    // Should not throw
    await expect(
      logConsentViolation(supabase as any, {
        organizationId: 'org-1',
        leadId: 'lead-1',
        channel: 'sms',
        reason: 'opted_out',
      })
    ).resolves.toBeUndefined()
  })
})

describe('isEligibleForConsentCapture', () => {
  it('eligible when status unknown and not opted out (sms)', () => {
    expect(isEligibleForConsentCapture({ sms_consent_status: 'unknown', sms_opt_out: false }, 'sms')).toBe(true)
  })

  it('not eligible when already granted', () => {
    expect(isEligibleForConsentCapture({ sms_consent_status: 'granted' }, 'sms')).toBe(false)
  })

  it('not eligible when declined', () => {
    expect(isEligibleForConsentCapture({ sms_consent_status: 'declined' }, 'sms')).toBe(false)
  })

  it('not eligible when opted out even if status stale-unknown', () => {
    expect(isEligibleForConsentCapture({ sms_consent_status: 'unknown', sms_opt_out: true }, 'sms')).toBe(false)
  })

  it('voice: not eligible when do_not_call set, even if status unknown', () => {
    expect(
      isEligibleForConsentCapture(
        { voice_consent_status: 'unknown', voice_opt_out: false, do_not_call: true },
        'voice'
      )
    ).toBe(false)
  })

  it('voice: eligible when unknown, not opted out, not DNC', () => {
    expect(
      isEligibleForConsentCapture(
        { voice_consent_status: 'unknown', voice_opt_out: false, do_not_call: false },
        'voice'
      )
    ).toBe(true)
  })

  it('email: eligible when unknown and not opted out', () => {
    expect(isEligibleForConsentCapture({ email_consent_status: 'unknown', email_opt_out: false }, 'email')).toBe(true)
  })
})
