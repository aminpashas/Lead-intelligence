// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { LogCallDialog } from '@/components/crm/log-call-dialog'

// No App Router in jsdom — router.refresh() after a successful save is a no-op here.
const refresh = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh }),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

beforeEach(() => {
  // The dialog lazily fetches the practice's discovery script on first open.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      String(url).includes('/api/discovery-script')
        ? { ok: true, json: async () => ({ script: 'Ask about their timeline.' }) }
        : { ok: true, json: async () => ({ ok: true, call_id: 'call-1' }) }
    )
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('LogCallDialog trigger contract', () => {
  it('renders its own "Log Call" chip when uncontrolled', () => {
    render(<LogCallDialog leadId="lead-1" />)
    expect(screen.getByText('Log Call')).toBeDefined()
    // Closed until the chip is clicked — the form is not mounted.
    expect(screen.queryByText('Log a call')).toBeNull()
  })

  it('renders no trigger when a parent drives `open` (the LeadActions bar case)', () => {
    render(<LogCallDialog leadId="lead-1" open={false} onOpenChange={vi.fn()} />)
    // The bar renders its own button; a second built-in chip would be a dupe.
    expect(screen.queryByText('Log Call')).toBeNull()
  })

  it('opens from the parent`s `open` prop alone, with no trigger click', async () => {
    render(<LogCallDialog leadId="lead-1" open onOpenChange={vi.fn()} />)
    expect(await screen.findByText('Log a call')).toBeDefined()
  })
})

describe('LogCallDialog save', () => {
  it('posts the call to the lead`s calls route and closes via onOpenChange', async () => {
    const onOpenChange = vi.fn()
    render(<LogCallDialog leadId="lead-42" open onOpenChange={onOpenChange} />)

    fireEvent.click(await screen.findByRole('button', { name: /^Log call$/i }))

    await waitFor(() => {
      const post = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
        ([url]) => String(url) === '/api/leads/lead-42/calls'
      )
      expect(post).toBeDefined()
      expect(JSON.parse(post![1].body)).toMatchObject({
        direction: 'outbound',
        outcome: 'interested',
        duration_seconds: 0,
        testimonial_sent: false,
      })
    })

    // Controlled mode must close through the parent, not local state.
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })
})
