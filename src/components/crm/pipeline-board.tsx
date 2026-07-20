'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragStartEvent,
  type DragEndEvent,
  type ScreenReaderInstructions,
  type UniqueIdentifier,
} from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { PipelineColumn } from './pipeline-column'
import { LeadCard } from './lead-card'
import type { Lead, PipelineStage } from '@/types/database'
import type { StageSuggestion } from '@/lib/pipeline/suggest-stage'
import { classifyContactedState, type TimelineEnrollment } from '@/lib/pipeline/contacted-state'
import { isActiveContactStage } from '@/lib/pipeline/stage-groups'
import { PipelineServiceChips } from './pipeline-service-chips'
import { toast } from 'sonner'

// Spoken to screen-reader users when a card receives focus — the cards are
// announced as sortable, so tell them the actual key bindings.
const screenReaderInstructions: ScreenReaderInstructions = {
  draggable:
    'To pick up a lead card, press space or enter. While dragging, use the arrow keys to move the card between pipeline stages. Press space or enter again to drop the card in its new stage, or press escape to cancel.',
}

export function PipelineBoard({
  stages,
  leads: initialLeads,
  stageCounts,
  totalLeadCount = 0,
  serviceCounts = {},
  activeService = null,
  probabilityByLead,
  suggestionByLead,
  enrollments,
}: {
  stages: PipelineStage[]
  leads: Lead[]
  /** True per-stage totals (stage_id → count), decoupled from the capped cards
   *  actually rendered. Column headers show these instead of leads.length.
   *  Treatment-filtered server-side when a service is active. */
  stageCounts?: Record<string, number>
  /** Whole-book grand total for the "All" chip (unfiltered by treatment). */
  totalLeadCount?: number
  /** Whole-book per-service totals for the chips — computed server-side so the
   *  chips reflect the real book, not the loaded card sample. */
  serviceCounts?: Record<string, number>
  /** Active treatment filter (service key) from the URL, or null for "All". */
  activeService?: string | null
  probabilityByLead?: Record<string, number>
  suggestionByLead?: Record<string, StageSuggestion>
  /** Follow-up cadence enrollment per lead (Following Up / Engaged stages only). */
  enrollments?: Record<string, TimelineEnrollment>
}) {
  const [leads, setLeads] = useState(initialLeads)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  // Local ± overlay on the server-provided per-stage totals. Successful drags
  // no longer round-trip the whole page (no router.refresh), so the column
  // headers stay truthful by adjusting the counts client-side instead.
  const [countDelta, setCountDelta] = useState<Record<string, number>>({})
  // Destination of the most recent move, plus a monotonic nonce so two moves
  // into the same column still register as distinct reveals.
  const [reveal, setReveal] = useState<{ stageId: string; n: number } | null>(null)
  const router = useRouter()

  useEffect(() => { setMounted(true) }, [])

  // Drag optimism replaces server data locally, but a treatment switch is a
  // navigation (see selectService) — so `leads` is always already scoped to the
  // active service by the server. Render it as-is; no client-side filtering.
  // Fresh server data also carries fresh stageCounts — drop the local overlay.
  useEffect(() => {
    setLeads(initialLeads)
    setCountDelta({})
  }, [initialLeads])

  // True stage total for a column header: server count + local drag overlay.
  const stageCountFor = useCallback(
    (stageId: string) => {
      const base = stageCounts?.[stageId]
      if (base == null) return undefined
      return base + (countDelta[stageId] ?? 0)
    },
    [stageCounts, countDelta]
  )

  // Split Mouse/Touch rather than using PointerSensor. PointerSensor treats a
  // finger like a mouse, so its distance-only constraint made an 8px swipe start
  // a drag — which fought the column's vertical scroll and the board's
  // horizontal scroll, leaving the board effectively undraggable on a phone.
  // Touch now needs a deliberate long-press; a quick swipe scrolls as expected.
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  // ── Accessibility: name things for the screen reader ──────
  // Cards are announced as sortable (role="button" from dnd-kit attributes), so
  // narrate drags with the lead's name and the destination column's name.
  const leadNameOf = useCallback(
    (id: UniqueIdentifier) => {
      const l = leads.find((x) => x.id === id)
      return l ? `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim() || 'Lead' : 'Lead'
    },
    [leads]
  )

  // `over` can be a column droppable (stage id) or a card inside one (lead id)
  // — resolve either to the stage it represents.
  const stageOf = useCallback(
    (id: UniqueIdentifier | undefined): PipelineStage | null => {
      if (id == null) return null
      const stage = stages.find((s) => s.id === id)
      if (stage) return stage
      const lead = leads.find((l) => l.id === id)
      return lead ? stages.find((s) => s.id === lead.stage_id) ?? null : null
    },
    [stages, leads]
  )

  const announcements: Announcements = {
    onDragStart({ active }) {
      const from = stageOf(active.id)
      return `Picked up lead ${leadNameOf(active.id)}${from ? ` in the ${from.name} stage` : ''}.`
    },
    onDragOver({ active, over }) {
      const dest = stageOf(over?.id)
      return dest
        ? `Lead ${leadNameOf(active.id)} is over the ${dest.name} stage.`
        : `Lead ${leadNameOf(active.id)} is no longer over a stage.`
    },
    onDragEnd({ active, over }) {
      const dest = stageOf(over?.id)
      return dest
        ? `Lead ${leadNameOf(active.id)} was dropped into the ${dest.name} stage.`
        : `Lead ${leadNameOf(active.id)} was dropped.`
    },
    onDragCancel({ active }) {
      return `Dragging was cancelled. Lead ${leadNameOf(active.id)} was returned to its original stage.`
    },
  }

  const activeLead = activeId ? leads.find((l) => l.id === activeId) : null
  // Keep the Day-N cadence badge on the floating drag-preview card too, matching
  // how PipelineColumn builds it, so the badge doesn't vanish mid-drag.
  const activeStage = activeLead ? stages.find((s) => s.id === activeLead.stage_id) : null
  const activeCadence =
    activeLead && activeStage && isActiveContactStage(activeStage.slug)
      ? {
          enrollment: enrollments?.[activeLead.id] ?? null,
          engaged:
            activeStage.slug === 'engaged' ||
            classifyContactedState(
              {
                last_contacted_at: activeLead.last_contacted_at ?? null,
                last_responded_at: activeLead.last_responded_at ?? null,
                total_messages_received: activeLead.total_messages_received ?? null,
              },
              Date.now()
            ) === 'engaged',
        }
      : undefined

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string)
  }, [])

  const moveLeadToStage = useCallback(
    async (leadId: string, newStageId: string) => {
      const lead = leads.find((l) => l.id === leadId)
      if (!lead || lead.stage_id === newStageId) return
      const fromStageId = lead.stage_id
      // Where the card sat in the server ordering — used to put it back exactly
      // if the PATCH fails.
      const fromIndex = leads.findIndex((l) => l.id === leadId)

      // Optimistic update. Columns render `leads.filter(stage)` in array order,
      // so re-stamping stage_id in place would drop the card wherever its old
      // index happens to land in the new column — usually buried below the fold.
      // Prepend it instead: a card you just moved should be the one you see.
      setLeads((prev) => [
        { ...lead, stage_id: newStageId },
        ...prev.filter((l) => l.id !== leadId),
      ])
      setReveal((prev) => ({ stageId: newStageId, n: (prev?.n ?? 0) + 1 }))

      // Update via API — same endpoint the drag path uses
      try {
        const res = await fetch(`/api/leads/${leadId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage_id: newStageId }),
        })

        if (!res.ok) throw new Error('Failed to update')
        // No router.refresh() here: the optimistic card move is the truth, and
        // a refresh would re-run the whole page's queries AND clobber any
        // in-flight drag via the initialLeads sync effect above. Keep the
        // header counts truthful with a local ± overlay instead.
        setCountDelta((prev) => {
          const next = { ...prev, [newStageId]: (prev[newStageId] ?? 0) + 1 }
          if (fromStageId) next[fromStageId] = (prev[fromStageId] ?? 0) - 1
          return next
        })
        toast.success('Lead moved successfully')
      } catch {
        // Revert on failure — stage AND position, or the card would sit at the
        // top of the column it never actually left.
        setLeads((prev) => {
          const without = prev.filter((l) => l.id !== leadId)
          without.splice(fromIndex, 0, lead)
          return without
        })
        toast.error('Failed to move lead')
      }
    },
    [leads]
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      setActiveId(null)
      if (!over) return
      // The keyboard sensor (and pointer drops onto a card) land on a lead id,
      // not the column droppable — resolve to the destination stage either way.
      const destStage = stageOf(over.id)
      if (!destStage) return
      void moveLeadToStage(active.id as string, destStage.id)
    },
    [moveLeadToStage, stageOf]
  )

  // One-click approval of an AI-suggested stage move (suggest → approve).
  const handleApplySuggestion = useCallback(
    (leadId: string, toStageId: string) => {
      void moveLeadToStage(leadId, toStageId)
    },
    [moveLeadToStage]
  )

  // Treatment filter chips — shared with the List view (see
  // PipelineServiceChips) so both renderings of the funnel filter identically.
  const chipRow = (
    <PipelineServiceChips
      totalLeadCount={totalLeadCount}
      serviceCounts={serviceCounts}
      activeService={activeService}
    />
  )

  // Prevent hydration mismatch — DnD-kit generates unique IDs at runtime
  if (!mounted) {
    return (
      <div>
        {chipRow}
        <div className="flex gap-3 overflow-x-auto pb-4 h-[calc(100vh-16rem)]">
          {stages.filter((s) => !s.is_lost).map((stage) => {
            const stageLeads = leads.filter((l) => l.stage_id === stage.id)
            return (
              <PipelineColumn key={stage.id} stage={stage} leads={stageLeads} totalCount={stageCountFor(stage.id)} onLeadClick={(id) => router.push(`/leads/${id}`)} probabilityByLead={probabilityByLead} suggestionByLead={suggestionByLead} enrollments={enrollments} />
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      accessibility={{ announcements, screenReaderInstructions }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      {chipRow}
      <div className="flex gap-3 overflow-x-auto pb-4 h-[calc(100vh-16rem)]">
        {stages
          .filter((s) => !s.is_lost)
          .map((stage) => {
            const stageLeads = leads.filter((l) => l.stage_id === stage.id)
            return (
              <PipelineColumn
                key={stage.id}
                stage={stage}
                leads={stageLeads}
                totalCount={stageCountFor(stage.id)}
                onLeadClick={(id) => router.push(`/leads/${id}`)}
                probabilityByLead={probabilityByLead}
                suggestionByLead={suggestionByLead}
                onApplySuggestion={handleApplySuggestion}
                enrollments={enrollments}
                revealToken={reveal?.stageId === stage.id ? reveal.n : undefined}
              />
            )
          })}
      </div>

      <DragOverlay>
        {activeLead && <LeadCard lead={activeLead} cadence={activeCadence} />}
      </DragOverlay>
    </DndContext>
  )
}
