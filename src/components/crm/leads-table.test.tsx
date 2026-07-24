// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { LeadsTable } from '@/components/crm/leads-table'
import type { Lead, PipelineStage } from '@/types/database'

// The table drives paging through the URL, so the router push is the assertion
// surface: whatever it is handed IS the next page's query string.
const push = vi.hoisted(() => vi.fn())
let currentParams = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => currentParams,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// Rendered per row by LeadActions; irrelevant to paging.
vi.mock('@/components/voice/softphone-provider', () => ({
  useSoftphone: () => ({ startCall: vi.fn(), startCallToNumber: vi.fn() }),
}))

const lead = {
  id: 'lead-1',
  first_name: 'Pat',
  last_name: 'Rivera',
  phone: '+15551234567',
  email: 'pat@example.com',
  status: 'new',
  qualification: 'warm',
  engagement_score: 40,
  total_messages_sent: 1,
  total_messages_received: 0,
  created_at: new Date('2026-01-01T00:00:00Z').toISOString(),
  sms_opt_out: false,
  email_opt_out: false,
  voice_opt_out: false,
  do_not_call: false,
} as unknown as Lead

const stages: PipelineStage[] = []

// 55,641 leads at 50/page — the real list from the bug report. Page 1 of 1,113.
function renderTable(page: number) {
  return render(
    <LeadsTable leads={[lead]} stages={stages} total={55641} page={page} perPage={50} />
  )
}

/** The `page` value of the last router.push, or null if none was set. */
function pushedPage() {
  const url = push.mock.calls.at(-1)?.[0] as string
  return new URLSearchParams(url.split('?')[1]).get('page')
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  currentParams = new URLSearchParams()
})

describe('LeadsTable pagination', () => {
  it('advances to page 2 when the next arrow is clicked', () => {
    currentParams = new URLSearchParams('page=1')
    renderTable(1)
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    // Regression: paging used to run through updateFilters(), which reset the
    // page to 1 after setting it — the arrow appeared dead on every list.
    expect(pushedPage()).toBe('2')
  })

  it('keeps active filters when paging', () => {
    currentParams = new URLSearchParams('page=3&status=new&sort=score&dir=desc')
    renderTable(3)
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    const params = new URLSearchParams((push.mock.calls.at(-1)?.[0] as string).split('?')[1])
    expect(params.get('page')).toBe('4')
    expect(params.get('status')).toBe('new')
    expect(params.get('sort')).toBe('score')
    expect(params.get('dir')).toBe('desc')
  })

  it('goes back a page on the previous arrow', () => {
    currentParams = new URLSearchParams('page=4')
    renderTable(4)
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }))
    expect(pushedPage()).toBe('3')
  })

  it('disables the arrows at the ends of the range', () => {
    currentParams = new URLSearchParams('page=1')
    const { unmount } = renderTable(1)
    expect((screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(false)
    unmount()

    currentParams = new URLSearchParams('page=1113')
    renderTable(1113) // ceil(55641 / 50) — the last page
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('still resets to page 1 when a filter changes', () => {
    currentParams = new URLSearchParams('page=7&status=new')
    renderTable(7)
    // Search is the filter path that is reachable without opening a Select.
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'rivera' } })
    fireEvent.keyDown(screen.getByPlaceholderText(/search/i), { key: 'Enter' })
    const params = new URLSearchParams((push.mock.calls.at(-1)?.[0] as string).split('?')[1])
    expect(params.get('search')).toBe('rivera')
    expect(params.get('page')).toBe('1')
  })
})
