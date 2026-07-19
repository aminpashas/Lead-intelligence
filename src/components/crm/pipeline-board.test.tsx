// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { PipelineBoard } from '@/components/crm/pipeline-board'
import type { Lead, PipelineStage } from '@/types/database'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  // The shared treatment chips read the active service off the URL.
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/pipeline',
}))

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: toastError } }))

const NEW = { id: 'stage-new', name: 'New Lead', slug: 'new-lead' } as PipelineStage
const NURTURING = { id: 'stage-nurturing', name: 'Nurturing', slug: 'nurturing' } as PipelineStage

function lead(id: string, first: string, stageId: string): Lead {
  return {
    id,
    first_name: first,
    last_name: 'Test',
    stage_id: stageId,
    created_at: '2026-07-01T12:00:00.000Z',
  } as Lead
}

// Ana sits LAST in the server ordering and moves into a column that already has
// two cards — the exact shape that used to bury a just-moved card mid-column.
const ZOE = lead('lead-zoe', 'Zoe', NURTURING.id)
const YARA = lead('lead-yara', 'Yara', NURTURING.id)
const ANA = lead('lead-ana', 'Ana', NEW.id)

/** Names of the cards rendered in a column, in visual top-to-bottom order.
 *  Anchored on the column shell (w-72) that wraps the stage heading. */
function columnOrder(stage: PipelineStage): string[] {
  const column = screen.getByText(stage.name).closest('div.w-72')!
  return Array.from(column.querySelectorAll('a[href^="/leads/"]')).map((el) =>
    el.textContent!.replace(/\s+/g, ' ').trim()
  )
}

function renderBoard() {
  return render(
    <PipelineBoard
      stages={[NEW, NURTURING]}
      leads={[ZOE, YARA, ANA]}
      stageCounts={{ [NEW.id]: 1, [NURTURING.id]: 2 }}
      suggestionByLead={{
        [ANA.id]: { toStageId: NURTURING.id, toStageName: 'Nurturing' } as never,
      }}
    />
  )
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('PipelineBoard stage moves', () => {
  it('puts a moved lead at the top of its new column', async () => {
    renderBoard()

    // Sanity: Ana starts in New Lead, and Nurturing already has two cards.
    expect(columnOrder(NURTURING)).not.toContain('Ana Test')

    fireEvent.click(screen.getByText(/move to Nurturing/i))

    await waitFor(() => {
      expect(columnOrder(NURTURING)[0]).toContain('Ana')
    })
    expect(columnOrder(NEW)).not.toContain('Ana Test')
  })

  it('scrolls the destination column back to the top so the card is visible', async () => {
    // A column the user had scrolled down would hide the prepended card. jsdom
    // has no scrollTo, so install one that records which element it fired on.
    const scrolled: Array<{ el: Element; top: number }> = []
    Object.defineProperty(Element.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value: function (this: Element, opts: { top: number }) {
        scrolled.push({ el: this, top: opts.top })
      },
    })

    renderBoard()
    fireEvent.click(screen.getByText(/move to Nurturing/i))

    await waitFor(() => expect(scrolled.length).toBeGreaterThan(0))
    expect(scrolled.every((s) => s.top === 0)).toBe(true)
    // ...and it was Nurturing's list that scrolled, not New Lead's.
    const nurturing = screen.getByText(NURTURING.name).closest('div.w-72')!
    expect(scrolled.every((s) => nurturing.contains(s.el))).toBe(true)
  })

  it('restores the original position when the move fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })))
    renderBoard()

    const before = columnOrder(NEW)
    fireEvent.click(screen.getByText(/move to Nurturing/i))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    // Back in New Lead — not stranded at the top of Nurturing.
    expect(columnOrder(NEW)).toEqual(before)
    expect(columnOrder(NURTURING)).not.toContain('Ana Test')
  })
})
