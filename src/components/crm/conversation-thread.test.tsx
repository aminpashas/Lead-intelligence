// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ConversationThread } from '@/components/crm/conversation-thread'
import type { Conversation, Lead, Message } from '@/types/database'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/conversations/c1',
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }))

// Polling hooks — keep the thread inert in jsdom.
vi.mock('@/lib/hooks/use-live-call', () => ({ useLiveCall: () => ({ status: 'idle', call: null }) }))
vi.mock('@/lib/hooks/use-conversation-presence', () => ({ useConversationPresence: () => {} }))

// Heavy children irrelevant to composer/attachment behaviour.
vi.mock('@/components/crm/lead-actions', () => ({ LeadActions: () => null }))
vi.mock('@/components/crm/stage-select', () => ({ StageSelect: () => null }))
vi.mock('@/components/crm/ai-mode-toggle', () => ({ AIModeToggle: () => null }))
vi.mock('@/components/crm/live-call-panel', () => ({ LiveCallIndicator: () => null, LiveCallPanel: () => null }))
vi.mock('@/components/crm/call-card', () => ({ CallCard: () => null }))
vi.mock('@/components/crm/lead-notes-panel', () => ({ LeadNotesPanel: () => null }))
vi.mock('@/components/crm/sla-countdown', () => ({ SlaCountdown: () => null }))
vi.mock('@/components/crm/agent-indicator', () => ({ AgentMessageLabel: () => null }))

const lead = {
  id: 'lead-1',
  first_name: 'Heather',
  last_name: 'Hawes',
  phone: '+14155550123',
  email: 'h@example.com',
} as Lead

function conversation(channel: string): Conversation {
  return { id: 'c1', lead_id: 'lead-1', channel, status: 'active' } as unknown as Conversation
}

function message(over: Partial<Message>): Message {
  return {
    id: 'm1',
    conversation_id: 'c1',
    lead_id: 'lead-1',
    direction: 'inbound',
    channel: 'messenger',
    body: '',
    subject: null,
    sender_type: 'lead',
    status: 'delivered',
    attachments: [],
    created_at: '2026-07-20T00:00:00.000Z',
    ...over,
  } as Message
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: true, media: q, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ConversationThread composer channel lock', () => {
  it('locks a Messenger thread to Messenger and removes the SMS/Email toggle', () => {
    // THE regression this guards: the composer seeded to 'sms' for any non-email
    // thread, so replying to a Messenger DM sent a TEXT to the lead's phone —
    // a misroute and a consent violation.
    render(
      <ConversationThread
        lead={lead}
        conversation={conversation('messenger')}
        messages={[message({ body: 'Do you do full arch implants?' })]}
      />
    )
    expect(screen.getByText(/Reply on Messenger/i)).toBeDefined()

    const labels = screen.getAllByRole('button').map((b) => b.textContent?.trim())
    expect(labels).not.toContain('Text')
    expect(labels).not.toContain('Email')
  })

  it('locks an Instagram thread to Instagram', () => {
    render(
      <ConversationThread
        lead={lead}
        conversation={conversation('instagram')}
        messages={[message({ channel: 'instagram', body: 'hi' })]}
      />
    )
    expect(screen.getByText(/Reply on Instagram/i)).toBeDefined()
  })

  it('keeps the Text/Email toggle on a normal SMS thread', () => {
    render(
      <ConversationThread
        lead={lead}
        conversation={conversation('sms')}
        messages={[message({ channel: 'sms', body: 'hi' })]}
      />
    )
    const labels = screen.getAllByRole('button').map((b) => b.textContent?.trim())
    expect(labels).toContain('Text')
    expect(labels).toContain('Email')
    expect(screen.queryByText(/Reply on Messenger/i)).toBeNull()
  })
})

describe('ConversationThread attachments', () => {
  it('renders an image for an attachment-only DM with no body', () => {
    // Patients DM photos of their teeth; the bubble must stand on the image.
    const url = 'https://static-assets.example/conversations/tooth.png'
    render(
      <ConversationThread
        lead={lead}
        conversation={conversation('messenger')}
        messages={[message({ body: '', attachments: [url] })]}
      />
    )
    const img = screen.getByAltText('Attachment') as HTMLImageElement
    expect(img.src).toBe(url)
  })

  it('renders a non-image attachment as a link, not a broken image', () => {
    const url = 'https://static-assets.example/conversations/report.pdf'
    render(
      <ConversationThread
        lead={lead}
        conversation={conversation('messenger')}
        messages={[message({ body: '', attachments: [url] })]}
      />
    )
    expect(screen.queryByAltText('Attachment')).toBeNull()
    const link = screen.getByText(/Attachment/i).closest('a') as HTMLAnchorElement
    expect(link.href).toBe(url)
    // Third-party host — must not get window.opener access.
    expect(link.rel).toContain('noopener')
  })
})
