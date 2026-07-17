// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { LeadActions } from '@/components/crm/lead-actions'
import type { Lead } from '@/types/database'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// LeadActions calls useSoftphone() for the "Call — you talk" path. The Log-call
// button under test doesn't touch it, so a stub start fn is enough.
const startCall = vi.hoisted(() => vi.fn())
vi.mock('@/components/voice/softphone-provider', () => ({
  useSoftphone: () => ({ startCall, startCallToNumber: vi.fn() }),
}))

// Minimal lead — only the fields LeadActions reads. Reachable on every channel
// and not on any opt-out, so nothing else in the bar is disabled.
const lead = {
  id: 'lead-1',
  first_name: 'Pat',
  last_name: 'Rivera',
  phone: '+15551234567',
  email: 'pat@example.com',
  status: 'new',
  sms_opt_out: false,
  email_opt_out: false,
  voice_opt_out: false,
  do_not_call: false,
} as unknown as Lead

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('LeadActions — Log call entry point', () => {
  it('renders a "Log call" button in the full bar', () => {
    render(<LeadActions lead={lead} variant="bar" />)
    expect(screen.getByRole('button', { name: 'Log call' })).toBeDefined()
  })

  it('renders the Log-call control in the compact row too (icon-only, exposed via title)', () => {
    render(<LeadActions lead={lead} variant="compact" />)
    // Compact buttons hide their text label, so the accessible name comes from
    // the title attr the shared `action` helper sets. This is the surface that
    // could not be visually screenshotted without auth — assert it exists.
    expect(screen.getByTitle('Log call')).toBeDefined()
  })

  it('opens the manual call-log dialog when clicked (was unreachable before)', () => {
    render(<LeadActions lead={lead} variant="bar" />)
    // Dialog is closed initially — its title is not mounted.
    expect(screen.queryByText('Log a call')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Log call' }))
    expect(screen.getByText('Log a call')).toBeDefined()
  })

  it('is never disabled, even when every channel is on Do-Not-Disturb / DNC', () => {
    const muted = { ...lead, sms_opt_out: true, email_opt_out: true, voice_opt_out: true, do_not_call: true } as unknown as Lead
    render(<LeadActions lead={muted} variant="bar" />)
    const logCall = screen.getByRole('button', { name: 'Log call' })
    expect((logCall as HTMLButtonElement).disabled).toBe(false)
    // Meanwhile the outbound-reaching buttons ARE blocked, proving the contrast
    // is intentional rather than a missing gate.
    expect((screen.getByRole('button', { name: 'SMS' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('places Log call between the Call split-control and SMS', () => {
    const { container } = render(<LeadActions lead={lead} variant="bar" />)
    const labels = within(container)
      .getAllByRole('button')
      .map((b) => b.textContent?.trim())
      .filter((t) => ['Call', 'Log call', 'SMS', 'Email'].includes(t ?? ''))
    // The realistic layout worry was Log call landing adjacent to Call with two
    // phone glyphs; confirm the intended order Call → Log call → SMS → Email.
    expect(labels).toEqual(['Call', 'Log call', 'SMS', 'Email'])
  })
})
