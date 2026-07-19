// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { CallCard } from '@/components/crm/call-card'
import type { VoiceCall } from '@/types/database'

const refresh = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh }),
}))

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: toastError } }))

// The recording player pulls in an <audio> pipeline that jsdom can't drive.
vi.mock('@/components/voice/call-recording-player', () => ({
  CallRecordingPlayer: () => <div data-testid="recording-player" />,
}))

/** A staff browser call that nobody dispositioned — the case this feature targets. */
const STAFF_CALL = {
  id: 'call-1',
  direction: 'outbound',
  call_mode: 'browser',
  duration_seconds: 150,
  outcome: null,
  outcome_notes: null,
  transcript: null,
  transcript_summary: 'Outbound call · 2:30. Answered.',
  recording_url: null,
  created_at: '2026-07-12T14:00:00.000Z',
  started_at: '2026-07-12T14:00:00.000Z',
  ended_at: '2026-07-12T14:02:30.000Z',
  status: 'completed',
  agent_type: null,
  staff_user_id: 'user-1',
} as unknown as VoiceCall

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('CallCard note amendment', () => {
  it('exposes a visible "Edit call notes" affordance', () => {
    // The hover button is the fallback for anyone without a right mouse button
    // (trackpad, touch) — it must exist independently of the context menu.
    render(<CallCard call={STAFF_CALL} />)
    expect(screen.getByLabelText('Edit call notes')).toBeDefined()
  })

  it('opens the notes editor from the visible button, expanding the card', async () => {
    render(<CallCard call={STAFF_CALL} />)
    fireEvent.click(screen.getByLabelText('Edit call notes'))

    const editor = await screen.findByPlaceholderText(/What happened on this call/i)
    expect(editor).toBeDefined()
  })

  it('PATCHes the disposition route with the amended notes', async () => {
    render(<CallCard call={STAFF_CALL} />)
    fireEvent.click(screen.getByLabelText('Edit call notes'))

    const editor = await screen.findByPlaceholderText(/What happened on this call/i)
    fireEvent.change(editor, { target: { value: 'Patient wants to start in September' } })
    fireEvent.click(screen.getByText('Save notes'))

    await waitFor(() => {
      const [url, init] = (fetch as any).mock.calls[0]
      expect(url).toBe('/api/voice/calls/call-1/disposition')
      expect(init.method).toBe('PATCH')
      expect(JSON.parse(init.body)).toEqual({ notes: 'Patient wants to start in September' })
    })
    expect(refresh).toHaveBeenCalled()
  })

  it('seeds the editor with the existing notes rather than blanking them', async () => {
    // Amending must never start from empty — that invites accidental erasure.
    render(<CallCard call={{ ...STAFF_CALL, outcome_notes: 'Left voicemail' } as VoiceCall} />)
    fireEvent.click(screen.getByLabelText('Edit call notes'))

    await waitFor(() => expect(screen.getByDisplayValue('Left voicemail')).toBeDefined())
  })

  it('surfaces a failed save instead of pretending it worked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({ error: 'Call not found' }) }))
    )
    render(<CallCard call={STAFF_CALL} />)
    fireEvent.click(screen.getByLabelText('Edit call notes'))

    const editor = await screen.findByPlaceholderText(/What happened on this call/i)
    fireEvent.change(editor, { target: { value: 'x' } })
    fireEvent.click(screen.getByText('Save notes'))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Call not found'))
    expect(refresh).not.toHaveBeenCalled()
  })

  it('cancelling discards the draft and keeps the stored notes', async () => {
    render(<CallCard call={{ ...STAFF_CALL, outcome_notes: 'Original' } as VoiceCall} />)
    fireEvent.click(screen.getByLabelText('Edit call notes'))

    const editor = await screen.findByPlaceholderText(/What happened on this call/i)
    fireEvent.change(editor, { target: { value: 'thrown away' } })
    fireEvent.click(screen.getByText('Cancel'))

    await waitFor(() => expect(screen.getByText('Original')).toBeDefined())
    expect(fetch).not.toHaveBeenCalled()
  })

  it('opens the same editor from a right-click', async () => {
    // The gesture the user actually asked for. If Base UI's ContextMenu does not
    // drive in jsdom this will fail loudly rather than leave the path assumed.
    render(<CallCard call={STAFF_CALL} />)

    fireEvent.contextMenu(screen.getByText('Outbound call'))

    const item = await screen.findByText(/call notes/i)
    fireEvent.click(item)

    expect(await screen.findByPlaceholderText(/What happened on this call/i)).toBeDefined()
  })
})
