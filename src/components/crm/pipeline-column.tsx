'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useDroppable } from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { LeadCard } from './lead-card'
import type { Lead, PipelineStage } from '@/types/database'
import type { StageSuggestion } from '@/lib/pipeline/suggest-stage'
import type { TimelineEnrollment } from '@/lib/pipeline/contacted-state'
import { classifyContactedState } from '@/lib/pipeline/contacted-state'
import { isActiveContactStage } from '@/lib/pipeline/stage-groups'

function SortableLeadCard({
  lead,
  onClick,
  closeProbability,
  suggestion,
  onApplySuggestion,
  cadence,
}: {
  lead: Lead
  onClick: () => void
  closeProbability?: number
  suggestion?: StageSuggestion | null
  onApplySuggestion?: (leadId: string, toStageId: string) => void
  cadence?: { enrollment: TimelineEnrollment | null; engaged: boolean }
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: lead.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={isDragging ? 'bg-aurea-surface-2 rounded-lg' : undefined}
    >
      <LeadCard
        lead={lead}
        onClick={onClick}
        closeProbability={closeProbability}
        suggestion={suggestion}
        onApplySuggestion={onApplySuggestion}
        cadence={cadence}
      />
    </div>
  )
}

export function PipelineColumn({
  stage,
  leads,
  totalCount,
  onLeadClick,
  probabilityByLead,
  suggestionByLead,
  onApplySuggestion,
  enrollments,
  revealToken,
}: {
  stage: PipelineStage
  leads: Lead[]
  /** True stage total. When larger than the rendered cards (the server caps how
   *  many cards load per column), the header shows this and a "showing N of
   *  total" line. Undefined → fall back to the rendered count (e.g. when a
   *  service filter is active and only the loaded sample is meaningful). */
  totalCount?: number
  onLeadClick: (id: string) => void
  probabilityByLead?: Record<string, number>
  suggestionByLead?: Record<string, StageSuggestion>
  onApplySuggestion?: (leadId: string, toStageId: string) => void
  /** Follow-up cadence enrollment per lead (Following Up / Engaged stages only). */
  enrollments?: Record<string, TimelineEnrollment>
  /** Bumped by the board when a lead is dropped into THIS column. The card is
   *  prepended, but a column the user had scrolled down would still hide it —
   *  so snap back to the top and actually show them the card they just moved. */
  revealToken?: number
}) {
  // Only the Following Up / Engaged columns carry a cadence timeline — everywhere
  // else `cadence` stays undefined and the card renders no badge.
  const isCadenceStage = isActiveContactStage(stage.slug)
  const { setNodeRef, isOver } = useDroppable({ id: stage.id })

  // The card list is its own scroll container, so it needs a ref of our own
  // alongside dnd-kit's droppable ref — fan one callback out to both.
  const listRef = useRef<HTMLDivElement | null>(null)
  const setListRef = useCallback(
    (node: HTMLDivElement | null) => {
      listRef.current = node
      setNodeRef(node)
    },
    [setNodeRef]
  )

  useEffect(() => {
    if (!revealToken) return
    // scrollTo is unimplemented in jsdom — optional-call so tests don't throw.
    listRef.current?.scrollTo?.({ top: 0, behavior: 'smooth' })
  }, [revealToken])

  // Header count is the true stage total when supplied; otherwise the rendered
  // card count. Note the cap when the book is larger than what we render.
  const headerCount = totalCount ?? leads.length
  const capped = totalCount != null && totalCount > leads.length

  // Calculate stage value
  const totalValue = leads.reduce((sum, l) => sum + (l.treatment_value || 0), 0)

  return (
    <div
      className={`flex flex-col w-72 shrink-0 rounded-lg border transition-colors ${
        isOver
          ? 'border-aurea-primary/40 bg-aurea-primary/5'
          : 'border-aurea-border bg-aurea-surface'
      }`}
    >
      {/* Header — flat, calm, eyebrow-style label */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-aurea-border">
        <div className="flex items-center gap-2">
          {/* Thin top-accent hairline dot using stage color */}
          <span
            className="h-1.5 w-1.5 rounded-full shrink-0"
            style={{ backgroundColor: stage.color }}
          />
          <span className="aurea-eyebrow leading-none">{stage.name}</span>
          <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3">
            {headerCount.toLocaleString()}
          </span>
        </div>
        {totalValue > 0 && (
          <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3">
            ${(totalValue / 1000).toFixed(0)}k
          </span>
        )}
      </div>

      {/* Cards are capped per column — make the truncation explicit so the count
          above never reads as "all of them are here". */}
      {capped && (
        <div className="px-3 py-1 border-b border-aurea-border text-[10px] uppercase tracking-wide text-aurea-ink-3">
          showing {leads.length} of {headerCount.toLocaleString()}
        </div>
      )}

      {/* Cards */}
      <div
        ref={setListRef}
        className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[200px]"
      >
        <SortableContext
          items={leads.map((l) => l.id)}
          strategy={verticalListSortingStrategy}
        >
          {leads.map((lead) => (
            <SortableLeadCard
              key={lead.id}
              lead={lead}
              onClick={() => onLeadClick(lead.id)}
              closeProbability={probabilityByLead?.[lead.id]}
              suggestion={suggestionByLead?.[lead.id] ?? null}
              onApplySuggestion={onApplySuggestion}
              cadence={
                isCadenceStage
                  ? {
                      enrollment: enrollments?.[lead.id] ?? null,
                      engaged:
                        stage.slug === 'engaged' ||
                        classifyContactedState(
                          {
                            last_contacted_at: lead.last_contacted_at ?? null,
                            last_responded_at: lead.last_responded_at ?? null,
                            total_messages_received: lead.total_messages_received ?? null,
                          },
                          Date.now()
                        ) === 'engaged',
                    }
                  : undefined
              }
            />
          ))}
        </SortableContext>

        {leads.length === 0 && (
          <div className="flex flex-col items-center justify-center h-24 text-[11px] text-aurea-ink-3 border border-dashed border-aurea-border rounded-lg">
            <span>Drop leads here</span>
          </div>
        )}
      </div>
    </div>
  )
}
