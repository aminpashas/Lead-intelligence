// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { LeadTaskCard, type LeadTask } from '@/components/crm/lead-task-card'

const refresh = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh }),
}))
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: toastError } }))

const TASK: LeadTask = {
  id: 'task-1',
  kind: 'callback',
  title: 'Call the patient back Friday',
  detail: null,
  status: 'open',
  priority: 'normal',
  due_at: null,
  assigned_to: null,
  reviewed_at: null,
  created_at: '2026-07-10T12:00:00.000Z',
}

const TEAM = [{ id: 'user-2', full_name: 'Marcus', email: 'm@x.co', role: 'agent' }]

function fetchOk() {
  return vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
}

beforeEach(() => vi.stubGlobal('fetch', fetchOk()))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('LeadTaskCard', () => {
  it('renders nothing when there are no live tasks', () => {
    const { container } = render(
      <LeadTaskCard leadId="lead-1" initialTasks={[]} teamMembers={TEAM} lastContactedAt={null} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders a row per task', () => {
    render(
      <LeadTaskCard leadId="lead-1" initialTasks={[TASK]} teamMembers={TEAM} lastContactedAt={null} />
    )
    expect(screen.getByText('Call the patient back Friday')).toBeTruthy()
  })

  it('flags a task as possibly moot when the lead was contacted after it was created', () => {
    render(
      <LeadTaskCard
        leadId="lead-1"
        initialTasks={[TASK]}
        teamMembers={TEAM}
        lastContactedAt="2026-07-12T09:00:00.000Z"
      />
    )
    expect(screen.getByText(/still needed/i)).toBeTruthy()
  })

  it('does NOT flag when the lead was contacted before it was created', () => {
    render(
      <LeadTaskCard
        leadId="lead-1"
        initialTasks={[TASK]}
        teamMembers={TEAM}
        lastContactedAt="2026-07-09T09:00:00.000Z"
      />
    )
    expect(screen.queryByText(/still needed/i)).toBeNull()
  })

  it('"Still relevant" PATCHes review and clears the moot flag without removing the row', async () => {
    render(
      <LeadTaskCard
        leadId="lead-1"
        initialTasks={[TASK]}
        teamMembers={TEAM}
        lastContactedAt="2026-07-12T09:00:00.000Z"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /still relevant/i }))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/tasks/task-1',
        expect.objectContaining({ method: 'PATCH' })
      )
    )
    expect(screen.getByText('Call the patient back Friday')).toBeTruthy()
    await waitFor(() => expect(screen.queryByText(/still needed/i)).toBeNull())
  })

  it('reverts and toasts on a failed update', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ error: 'nope' }) })))
    render(
      <LeadTaskCard leadId="lead-1" initialTasks={[TASK]} teamMembers={TEAM} lastContactedAt={null} />
    )
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(screen.getByText('Call the patient back Friday')).toBeTruthy()
  })
})
