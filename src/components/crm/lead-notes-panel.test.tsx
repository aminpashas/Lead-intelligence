// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { LeadNotesPanel, type LeadNote } from '@/components/crm/lead-notes-panel'

// No App Router in jsdom — router.refresh() after a save is a no-op here.
const refresh = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh }),
}))

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: toastError } }))

const MINE: LeadNote = {
  id: 'note-mine',
  created_at: '2026-07-10T15:00:00.000Z',
  description: 'Patient asked about financing options',
  user_id: 'user-1',
  author_name: 'Heather',
}

const THEIRS: LeadNote = {
  id: 'note-theirs',
  created_at: '2026-07-11T16:00:00.000Z',
  description: 'Left a voicemail, will retry Monday',
  user_id: 'user-2',
  author_name: 'Marcus',
}

function fetchOk() {
  return vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, note: MINE }) }))
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchOk())
  vi.stubGlobal('confirm', vi.fn(() => true))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('LeadNotesPanel', () => {
  it('renders every team member\'s notes, not just the viewer\'s', () => {
    render(<LeadNotesPanel leadId="lead-1" notes={[MINE, THEIRS]} currentUserId="user-1" />)
    expect(screen.getByText(MINE.description!)).toBeDefined()
    expect(screen.getByText(THEIRS.description!)).toBeDefined()
    expect(screen.getByText('Marcus')).toBeDefined()
  })

  it('invites the first note when the lead has none', () => {
    render(<LeadNotesPanel leadId="lead-1" notes={[]} currentUserId="user-1" />)
    expect(screen.getByText(/No notes yet/i)).toBeDefined()
  })

  describe('authorship', () => {
    it('offers edit + delete on the viewer\'s own note', () => {
      render(<LeadNotesPanel leadId="lead-1" notes={[MINE]} currentUserId="user-1" />)
      expect(screen.getByLabelText('Edit note')).toBeDefined()
      expect(screen.getByLabelText('Delete note')).toBeDefined()
    })

    it('offers neither on a teammate\'s note', () => {
      // The API is the real gate (403); the UI simply must not invite the attempt.
      render(<LeadNotesPanel leadId="lead-1" notes={[THEIRS]} currentUserId="user-1" />)
      expect(screen.queryByLabelText('Edit note')).toBeNull()
      expect(screen.queryByLabelText('Delete note')).toBeNull()
    })

    it('offers neither when the viewer is unidentified', () => {
      // A null currentUserId must not accidentally match a null user_id row.
      render(
        <LeadNotesPanel
          leadId="lead-1"
          notes={[{ ...MINE, user_id: null }]}
          currentUserId={null}
        />
      )
      expect(screen.queryByLabelText('Edit note')).toBeNull()
    })
  })

  describe('adding a note', () => {
    it('posts the note and clears the composer', async () => {
      render(<LeadNotesPanel leadId="lead-1" notes={[]} currentUserId="user-1" />)
      const box = screen.getByPlaceholderText(/Add a note for the team/i) as HTMLTextAreaElement

      fireEvent.change(box, { target: { value: 'Wants to start in September' } })
      fireEvent.click(screen.getByText('Add note'))

      await waitFor(() => {
        expect(fetch).toHaveBeenCalledWith(
          '/api/leads/lead-1/notes',
          expect.objectContaining({ method: 'POST' })
        )
      })
      const [, init] = (fetch as any).mock.calls[0]
      expect(JSON.parse(init.body)).toEqual({ body: 'Wants to start in September' })
      await waitFor(() => expect(box.value).toBe(''))
      expect(refresh).toHaveBeenCalled()
    })

    it('refuses to post an empty or whitespace-only note', () => {
      render(<LeadNotesPanel leadId="lead-1" notes={[]} currentUserId="user-1" />)
      const box = screen.getByPlaceholderText(/Add a note for the team/i)

      fireEvent.change(box, { target: { value: '   ' } })
      fireEvent.click(screen.getByText('Add note'))

      expect(fetch).not.toHaveBeenCalled()
    })

    it('surfaces a save failure instead of silently dropping the note', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: false, json: async () => ({ error: 'Failed to save note' }) }))
      )
      render(<LeadNotesPanel leadId="lead-1" notes={[]} currentUserId="user-1" />)

      fireEvent.change(screen.getByPlaceholderText(/Add a note for the team/i), {
        target: { value: 'something' },
      })
      fireEvent.click(screen.getByText('Add note'))

      await waitFor(() => expect(toastError).toHaveBeenCalledWith('Failed to save note'))
      expect(refresh).not.toHaveBeenCalled()
    })
  })

  describe('editing a note', () => {
    it('PATCHes the edited body with the note id', async () => {
      render(<LeadNotesPanel leadId="lead-1" notes={[MINE]} currentUserId="user-1" />)

      fireEvent.click(screen.getByLabelText('Edit note'))
      const editor = screen.getByDisplayValue(MINE.description!)
      fireEvent.change(editor, { target: { value: 'Financing approved' } })
      fireEvent.click(screen.getByText('Save'))

      await waitFor(() => {
        const [url, init] = (fetch as any).mock.calls[0]
        expect(url).toBe('/api/leads/lead-1/notes')
        expect(init.method).toBe('PATCH')
        expect(JSON.parse(init.body)).toEqual({
          note_id: 'note-mine',
          body: 'Financing approved',
        })
      })
    })

    it('cancelling leaves the note untouched', () => {
      render(<LeadNotesPanel leadId="lead-1" notes={[MINE]} currentUserId="user-1" />)

      fireEvent.click(screen.getByLabelText('Edit note'))
      fireEvent.change(screen.getByDisplayValue(MINE.description!), {
        target: { value: 'discarded' },
      })
      fireEvent.click(screen.getByText('Cancel'))

      expect(fetch).not.toHaveBeenCalled()
      expect(screen.getByText(MINE.description!)).toBeDefined()
    })
  })

  describe('deleting a note', () => {
    it('confirms first — deletes are permanent', () => {
      vi.stubGlobal('confirm', vi.fn(() => false))
      render(<LeadNotesPanel leadId="lead-1" notes={[MINE]} currentUserId="user-1" />)

      fireEvent.click(screen.getByLabelText('Delete note'))

      expect(confirm).toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    })

    it('DELETEs once confirmed', async () => {
      render(<LeadNotesPanel leadId="lead-1" notes={[MINE]} currentUserId="user-1" />)

      fireEvent.click(screen.getByLabelText('Delete note'))

      await waitFor(() => {
        const [, init] = (fetch as any).mock.calls[0]
        expect(init.method).toBe('DELETE')
        expect(JSON.parse(init.body)).toEqual({ note_id: 'note-mine' })
      })
    })
  })
})
