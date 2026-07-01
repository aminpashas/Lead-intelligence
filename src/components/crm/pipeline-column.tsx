'use client'

import { useDroppable } from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { LeadCard } from './lead-card'
import type { Lead, PipelineStage } from '@/types/database'

function SortableLeadCard({
  lead,
  onClick,
}: {
  lead: Lead
  onClick: () => void
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
      <LeadCard lead={lead} onClick={onClick} />
    </div>
  )
}

export function PipelineColumn({
  stage,
  leads,
  onLeadClick,
}: {
  stage: PipelineStage
  leads: Lead[]
  onLeadClick: (id: string) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id })

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
            {leads.length}
          </span>
        </div>
        {totalValue > 0 && (
          <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3">
            ${(totalValue / 1000).toFixed(0)}k
          </span>
        )}
      </div>

      {/* Cards */}
      <div
        ref={setNodeRef}
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
