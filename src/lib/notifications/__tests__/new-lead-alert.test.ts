import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/messaging/resend', () => ({
  sendEmail: vi.fn().mockResolvedValue({ id: 'email_1' }),
}))

import { sendEmail } from '@/lib/messaging/resend'
import {
  parseAlertRecipients,
  parseSlackRoutes,
  resolveSlackTargets,
  notifyNewLead,
} from '@/lib/notifications/new-lead-alert'

const FULL_ARCH_HOOK = 'https://hooks.slack.com/services/T000/B000/fullarch'
const TMJ_HOOK = 'https://hooks.slack.com/services/T000/B111/tmj'

describe('parseAlertRecipients', () => {
  it('falls back to the ops default list when unset', () => {
    expect(parseAlertRecipients(undefined)).toEqual([
      'asamadian@dionhealth.com',
      'hhawes@dionhealth.com',
    ])
  })

  it('parses, trims, lowercases and de-dupes a comma list', () => {
    expect(parseAlertRecipients('A@x.com, b@x.com ,A@x.com')).toEqual([
      'a@x.com',
      'b@x.com',
    ])
  })

  it('ignores blank/garbage entries and uses the default when nothing valid remains', () => {
    expect(parseAlertRecipients('   , not-an-email ,')).toEqual([
      'asamadian@dionhealth.com',
      'hhawes@dionhealth.com',
    ])
  })
})

describe('parseSlackRoutes', () => {
  it('returns an empty map when unset or blank', () => {
    expect(parseSlackRoutes(undefined)).toEqual({})
    expect(parseSlackRoutes('  ')).toEqual({})
  })

  it('returns an empty map on invalid JSON', () => {
    expect(parseSlackRoutes('{not json')).toEqual({})
  })

  it('keeps only https Slack-shaped webhook URLs', () => {
    const raw = JSON.stringify({
      implants: FULL_ARCH_HOOK,
      tmj: TMJ_HOOK,
      bad: 'https://evil.example.com/hook',
      alsoBad: 'not-a-url',
    })
    expect(parseSlackRoutes(raw)).toEqual({
      implants: FULL_ARCH_HOOK,
      tmj: TMJ_HOOK,
    })
  })
})

describe('resolveSlackTargets', () => {
  const routes = { implants: FULL_ARCH_HOOK, tmj: TMJ_HOOK, default: FULL_ARCH_HOOK }

  it('routes an implants lead to the full-arch channel', () => {
    expect(resolveSlackTargets(['implants'], routes)).toEqual([FULL_ARCH_HOOK])
  })

  it('routes a TMJ lead to the TMJ channel only', () => {
    expect(resolveSlackTargets(['tmj'], routes)).toEqual([TMJ_HOOK])
  })

  it('posts to both channels for a multi-line lead, de-duplicated by URL', () => {
    expect(resolveSlackTargets(['implants', 'tmj'], routes).sort()).toEqual(
      [FULL_ARCH_HOOK, TMJ_HOOK].sort(),
    )
  })

  it('falls back to the default route when no service line matches', () => {
    expect(resolveSlackTargets(['cosmetic'], { default: TMJ_HOOK })).toEqual([TMJ_HOOK])
  })

  it('skips entirely when no match and no default', () => {
    expect(resolveSlackTargets(['cosmetic'], { implants: FULL_ARCH_HOOK })).toEqual([])
  })
})

describe('notifyNewLead', () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    process.env.NEW_LEAD_ALERT_EMAILS = 'ops@dionhealth.com'
    process.env.NEW_LEAD_SLACK_ROUTES = JSON.stringify({
      implants: FULL_ARCH_HOOK,
      tmj: TMJ_HOOK,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.NEW_LEAD_ALERT_EMAILS
    delete process.env.NEW_LEAD_SLACK_ROUTES
  })

  it('emails every recipient and posts to the full-arch channel for an implant lead', async () => {
    await notifyNewLead({} as any, {
      organizationId: 'org1',
      lead: {
        id: 'lead1',
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane@x.com',
        phone: '+15551230000',
        source: 'ppc_google',
        utm_campaign: 'all-on-4 full arch implants',
      },
    })

    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect((sendEmail as any).mock.calls[0][0].to).toBe('ops@dionhealth.com')
    expect((sendEmail as any).mock.calls[0][0].subject).toContain('Jane Doe')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(FULL_ARCH_HOOK)
  })

  it('routes a TMJ lead to the TMJ channel', async () => {
    await notifyNewLead({} as any, {
      organizationId: 'org1',
      lead: {
        id: 'lead2',
        firstName: 'Sam',
        email: 'sam@x.com',
        utm_campaign: 'tmj jaw pain relief',
      },
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(TMJ_HOOK)
  })

  it('still emails when Slack is not configured', async () => {
    delete process.env.NEW_LEAD_SLACK_ROUTES
    await notifyNewLead({} as any, {
      organizationId: 'org1',
      lead: { id: 'lead3', firstName: 'Pat', email: 'pat@x.com' },
    })
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never throws when email delivery fails', async () => {
    ;(sendEmail as any).mockRejectedValueOnce(new Error('resend down'))
    await expect(
      notifyNewLead({} as any, {
        organizationId: 'org1',
        lead: { id: 'lead4', firstName: 'Kim', utm_campaign: 'implants' },
      }),
    ).resolves.toBeUndefined()
    // Slack still fires despite the email failure.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
