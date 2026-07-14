'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
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
import { SERVICE_LINES } from '@/lib/leads/service-line'
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

  // Switching treatment is a server round-trip: the URL drives which service the
  // board fetches (and counts), so clicking a chip shows that treatment's REAL
  // leads across the funnel — not a filter of the ≤80/stage sample. Toggling the
  // active chip (or "All") clears the filter.
  const selectService = useCallback(
    (key: string | null) => {
      const next = key && key !== activeService ? `/pipeline?service=${key}` : '/pipeline'
      router.push(next)
    },
    [activeService, router]
  )

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
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

      // Optimistic update
      setLeads((prev) =>
        prev.map((l) => (l.id === leadId ? { ...l, stage_id: newStageId } : l))
      )

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
        // Revert on failure
        setLeads((prev) =>
          prev.map((l) =>
            l.id === leadId ? { ...l, stage_id: lead.stage_id } : l
          )
        )
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

  // Treatment filter chips — only services with leads get a chip. Mirrors GHL's
  // "switch pipeline" but over one shared funnel. Counts are whole-book totals
  // computed server-side (serviceCounts), so the chips no longer disagree with
  // the funnel. Clicking one re-scopes the board via the URL.
  const chipRow = (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <ServiceChip
        label="All"
        count={totalLeadCount}
        active={activeService === null}
        onClick={() => selectService(null)}
      />
      {SERVICE_LINES.filter((s) => (serviceCounts[s.key] ?? 0) > 0).map((s) => (
        <ServiceChip
          key={s.key}
          label={s.label}
          count={serviceCounts[s.key]}
          active={activeService === s.key}
          onClick={() => selectService(s.key)}
        />
      ))}
    </div>
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

function ServiceChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] transition-colors ${
        active
          ? 'border-aurea-ink bg-aurea-ink text-white'
          : 'border-aurea-border bg-white text-aurea-ink-2 hover:border-aurea-ink/40 hover:text-aurea-ink'
      }`}
    >
      <span>{label}</span>
      <span
        className={`font-mono text-[11px] tabular-nums ${
          active ? 'text-white/70' : 'text-aurea-ink-3'
        }`}
      >
        {count}
      </span>
    </button>
  )
}
