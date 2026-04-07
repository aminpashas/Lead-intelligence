'use client'

import { useDroppable } from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { LeadCard } from './lead-card'
import { Badge } from '@/components/ui/badge'
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
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
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
      className={`flex flex-col w-72 shrink-0 rounded-lg border ${
        isOver ? 'border-primary bg-primary/5' : 'bg-muted/30'
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b">
        <div className="flex items-center gap-2">
          <div
            className="h-3 w-3 rounded-full"
            style={{ backgroundColor: stage.color }}
          />
          <h3 className="font-medium text-sm">{stage.name}</h3>
          <Badge variant="secondary" className="text-xs">
            {leads.length}
          </Badge>
        </div>
        {totalValue > 0 && (
          <span className="text-xs text-muted-foreground font-medium">
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
          <div className="flex items-center justify-center h-20 text-xs text-muted-foreground">
            No leads
          </div>
        )}
      </div>
    </div>
  )
}
