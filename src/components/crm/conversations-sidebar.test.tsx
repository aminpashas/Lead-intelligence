// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { ConversationsSidebar, type ConversationListItem } from '@/components/crm/conversations-sidebar'

vi.mock('next/navigation', () => ({
  usePathname: () => '/conversations',
  useSearchParams: () => new URLSearchParams(),
}))

function convo(over: Partial<ConversationListItem> & { id: string; channel: string }): ConversationListItem {
  return {
    leadId: `lead-${over.id}`,
    unread: 0,
    lastAt: '2026-07-20T00:00:00.000Z',
    preview: 'hello',
    aiEnabled: false,
    aiMode: null,
    sentiment: null,
    status: 'active',
    name: 'Test Patient',
    initials: 'TP',
    phone: null,
    email: null,
    score: null,
    qualification: null,
    ...over,
  } as ConversationListItem
}

/** The rail's segmented channel filter. */
function tabLabels(): string[] {
  return screen
    .getAllByRole('button')
    .map((b) => b.textContent?.trim() ?? '')
    .filter((t) => ['All', 'SMS', 'Email', 'Voice', 'FB', 'IG', 'WA', 'Web'].includes(t))
}

beforeEach(() => {
  // The rail ignores a stored collapse preference below `lg`; jsdom has no
  // matchMedia, so stub it as desktop.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ConversationsSidebar channel filter', () => {
  it('surfaces a Messenger tab when a Messenger thread exists', () => {
    // The bug: the filter was hardcoded to all|sms|email|voice, so social
    // threads were reachable only under "All" and vanished under any filter.
    render(
      <ConversationsSidebar
        conversations={[
          convo({ id: 'c1', channel: 'sms', name: 'Sms Person', leadId: 'l1' }),
          convo({ id: 'c2', channel: 'messenger', name: 'Fb Person', leadId: 'l2' }),
        ]}
      />
    )
    const tabs = tabLabels()
    expect(tabs).toContain('FB')
    expect(tabs).toContain('SMS')
  })

  it('shows an Instagram tab only when Instagram threads are present', () => {
    const { rerender } = render(
      <ConversationsSidebar conversations={[convo({ id: 'c1', channel: 'sms', leadId: 'l1' })]} />
    )
    expect(tabLabels()).not.toContain('IG')

    rerender(
      <ConversationsSidebar
        conversations={[
          convo({ id: 'c1', channel: 'sms', leadId: 'l1' }),
          convo({ id: 'c2', channel: 'instagram', leadId: 'l2' }),
        ]}
      />
    )
    expect(tabLabels()).toContain('IG')
  })

  it('filters the list down to the selected social channel', () => {
    render(
      <ConversationsSidebar
        conversations={[
          convo({ id: 'c1', channel: 'sms', name: 'Sms Person', leadId: 'l1' }),
          convo({ id: 'c2', channel: 'messenger', name: 'Fb Person', leadId: 'l2' }),
        ]}
      />
    )
    expect(screen.getByText('Sms Person')).toBeDefined()
    expect(screen.getByText('Fb Person')).toBeDefined()

    const fbTab = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'FB')!
    fireEvent.click(fbTab)

    expect(screen.queryByText('Sms Person')).toBeNull()
    expect(screen.getByText('Fb Person')).toBeDefined()
  })

  it('renders an unknown channel without crashing and offers no tab for it', () => {
    // Channel values arrive as raw DB strings; an unrecognized one must degrade
    // to a neutral row rather than throwing inside the rail.
    expect(() =>
      render(<ConversationsSidebar conversations={[convo({ id: 'c1', channel: 'tiktok', name: 'Tik Person', leadId: 'l1' })]} />)
    ).not.toThrow()
    expect(screen.getByText('Tik Person')).toBeDefined()
    expect(tabLabels()).not.toContain('IG')
  })

  it('groups a lead\'s SMS and Messenger threads into one row', () => {
    render(
      <ConversationsSidebar
        conversations={[
          convo({ id: 'c1', channel: 'sms', name: 'Same Person', leadId: 'shared' }),
          convo({ id: 'c2', channel: 'messenger', name: 'Same Person', leadId: 'shared' }),
        ]}
      />
    )
    expect(screen.getAllByText('Same Person')).toHaveLength(1)
  })
})
