// @vitest-environment jsdom
/**
 * Behaviour of the inline phone/email editor.
 *
 * The case that matters most is the empty one: a Messenger/Instagram lead
 * arrives with no phone and no email, and before this component there was no
 * affordance at all — the row simply didn't render, so staff had no way to add
 * what the lead had just typed into the thread.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { LeadContactField } from '@/components/crm/lead-contact-field'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function mockFetch(...responses: Array<{ status: number; body: unknown }>) {
  const fn = vi.fn()
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    })
  }
  global.fetch = fn as unknown as typeof fetch
  return fn
}

beforeEach(() => {
  global.fetch = vi.fn() as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('empty state — the reason this component exists', () => {
  it('offers "Add phone" when the lead has no phone', () => {
    render(<LeadContactField leadId="lead-1" field="phone" value={null} />)
    expect(screen.getByRole('button', { name: /add phone/i })).toBeDefined()
  })

  it('offers "Add email" when the lead has no email', () => {
    render(<LeadContactField leadId="lead-1" field="email" value={null} />)
    expect(screen.getByRole('button', { name: /add email/i })).toBeDefined()
  })

  it('shows the existing value when there is one', () => {
    render(<LeadContactField leadId="lead-1" field="phone" value="+15624465110" />)
    expect(screen.getByText('+15624465110')).toBeDefined()
  })
})

describe('saving a value', () => {
  it('PATCHes the raw typed string and reports the saved value upward', async () => {
    const fetchMock = mockFetch({ status: 200, body: { lead: { phone: '562-446-5110' } } })
    const onSaved = vi.fn()

    render(<LeadContactField leadId="lead-1" field="phone" value={null} onSaved={onSaved} />)
    fireEvent.click(screen.getByRole('button', { name: /add phone/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '562-446-5110' } })
    fireEvent.click(screen.getByRole('button', { name: /^save phone$/i }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('562-446-5110'))

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/leads/lead-1')
    expect(init.method).toBe('PATCH')
    // The server owns E.164 normalization — the client must not pre-format,
    // or the two would drift.
    expect(JSON.parse(init.body)).toEqual({ phone: '562-446-5110' })
  })

  it('saves on Enter', async () => {
    const fetchMock = mockFetch({ status: 200, body: { lead: {} } })
    render(<LeadContactField leadId="lead-1" field="email" value={null} />)

    fireEvent.click(screen.getByRole('button', { name: /add email/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'e@example.com' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })

  it('abandons the edit on Escape without calling the API', () => {
    const fetchMock = mockFetch()
    render(<LeadContactField leadId="lead-1" field="phone" value={null} />)

    fireEvent.click(screen.getByRole('button', { name: /add phone/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '5624465110' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /add phone/i })).toBeDefined()
  })

  it('does not call the API when the value is unchanged', () => {
    const fetchMock = mockFetch()
    render(<LeadContactField leadId="lead-1" field="phone" value="+15624465110" />)

    fireEvent.click(screen.getByRole('button', { name: /edit phone/i }))
    fireEvent.click(screen.getByRole('button', { name: /^save phone$/i }))

    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('duplicate phone — warn, then let the user confirm', () => {
  it('surfaces the warning instead of saving, then re-sends with confirmation', async () => {
    const fetchMock = mockFetch(
      {
        status: 409,
        body: {
          error: 'duplicate_phone',
          message: 'Elaine Ballard already has this number.',
          conflicts: [{ id: 'lead-2', name: 'Elaine Ballard' }],
        },
      },
      { status: 200, body: { lead: {} } },
    )
    const onSaved = vi.fn()

    render(<LeadContactField leadId="lead-1" field="phone" value={null} onSaved={onSaved} />)
    fireEvent.click(screen.getByRole('button', { name: /add phone/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '562-446-5110' } })
    fireEvent.click(screen.getByRole('button', { name: /^save phone$/i }))

    // First attempt: warned, not saved, still editing.
    await waitFor(() => expect(screen.getByText(/already has this number/i)).toBeDefined())
    expect(onSaved).not.toHaveBeenCalled()

    // Second attempt: the same click now means "yes, I meant it".
    fireEvent.click(screen.getByRole('button', { name: /save phone anyway/i }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('562-446-5110'))

    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      phone: '562-446-5110',
      confirm_duplicate_phone: true,
    })
  })

  it('drops a pending confirmation if the number is edited again', async () => {
    mockFetch(
      { status: 409, body: { error: 'duplicate_phone', message: 'Someone already has this.' } },
      { status: 200, body: { lead: {} } },
    )

    render(<LeadContactField leadId="lead-1" field="phone" value={null} />)
    fireEvent.click(screen.getByRole('button', { name: /add phone/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '562-446-5110' } })
    fireEvent.click(screen.getByRole('button', { name: /^save phone$/i }))
    await waitFor(() => expect(screen.getByText(/already has this/i)).toBeDefined())

    // Typing a different number must not inherit consent given for the old one.
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '562-446-5111' } })
    expect(screen.queryByText(/already has this/i)).toBeNull()
    expect(screen.getByRole('button', { name: /^save phone$/i })).toBeDefined()
  })
})

describe('server-side rejections', () => {
  it('keeps the user in the editor when the phone is rejected as invalid', async () => {
    mockFetch({ status: 400, body: { error: 'That does not look like a valid phone number.' } })
    const onSaved = vi.fn()

    render(<LeadContactField leadId="lead-1" field="phone" value={null} onSaved={onSaved} />)
    fireEvent.click(screen.getByRole('button', { name: /add phone/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '555-1212' } })
    fireEvent.click(screen.getByRole('button', { name: /^save phone$/i }))

    await waitFor(() => expect(screen.getByRole('textbox')).toBeDefined())
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('clears the field when submitted empty', async () => {
    const fetchMock = mockFetch({ status: 200, body: { lead: {} } })
    const onSaved = vi.fn()

    render(<LeadContactField leadId="lead-1" field="phone" value="+15624465110" onSaved={onSaved} />)
    fireEvent.click(screen.getByRole('button', { name: /edit phone/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /^save phone$/i }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(null))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ phone: '' })
  })
})
