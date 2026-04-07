'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { PipelineColumn } from './pipeline-column'
import { LeadCard } from './lead-card'
import type { Lead, PipelineStage } from '@/types/database'
import { toast } from 'sonner'

export function PipelineBoard({
  stages,
  leads: initialLeads,
}: {
  stages: PipelineStage[]
  leads: Lead[]
}) {
  const [leads, setLeads] = useState(initialLeads)
  const [activeId, setActiveId] = useState<string | null>(null)
  const router = useRouter()

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  )

  const activeLead = activeId ? leads.find((l) => l.id === activeId) : null

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string)
  }, [])

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event
      setActiveId(null)

      if (!over) return

      const leadId = active.id as string
      const newStageId = over.id as string

      const lead = leads.find((l) => l.id === leadId)
      if (!lead || lead.stage_id === newStageId) return

      // Optimistic update
      setLeads((prev) =>
        prev.map((l) => (l.id === leadId ? { ...l, stage_id: newStageId } : l))
      )

      // Update via API
      try {
        const res = await fetch(`/api/leads/${leadId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage_id: newStageId }),
        })

        if (!res.ok) throw new Error('Failed to update')
        toast.success('Lead moved successfully')
        router.refresh()
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
    [leads, router]
  )

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-4 overflow-x-auto pb-4 h-[calc(100vh-13rem)]">
        {stages
          .filter((s) => !s.is_lost)
          .map((stage) => {
            const stageLeads = leads.filter((l) => l.stage_id === stage.id)
            return (
              <PipelineColumn
                key={stage.id}
                stage={stage}
                leads={stageLeads}
                onLeadClick={(id) => router.push(`/leads/${id}`)}
              />
            )
          })}
      </div>

      <DragOverlay>
        {activeLead && <LeadCard lead={activeLead} />}
      </DragOverlay>
    </DndContext>
  )
}
