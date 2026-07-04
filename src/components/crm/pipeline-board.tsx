'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
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
import type { StageSuggestion } from '@/lib/pipeline/suggest-stage'
import { SERVICE_LINES, classifyLeadServiceLines } from '@/lib/leads/service-line'
import { toast } from 'sonner'

export function PipelineBoard({
  stages,
  leads: initialLeads,
  probabilityByLead,
  suggestionByLead,
}: {
  stages: PipelineStage[]
  leads: Lead[]
  probabilityByLead?: Record<string, number>
  suggestionByLead?: Record<string, StageSuggestion>
}) {
  const [leads, setLeads] = useState(initialLeads)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  // null = "All" (no treatment filter). GHL splits treatments into separate
  // pipelines; we keep one funnel and filter it down to a single service line.
  const [serviceFilter, setServiceFilter] = useState<string | null>(null)
  const router = useRouter()

  useEffect(() => { setMounted(true) }, [])

  // Classify each lead's service line(s) once. Recompute only when the lead set
  // changes (drag updates stage_id, not attribution, so this stays cheap).
  const serviceByLead = useMemo(() => {
    const m: Record<string, string[]> = {}
    for (const l of leads) m[l.id] = classifyLeadServiceLines(l)
    return m
  }, [leads])

  // Per-service counts across the whole book — only offer a chip for services
  // that actually have leads, so the row reflects this practice's mix.
  const serviceCounts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const lines of Object.values(serviceByLead)) {
      for (const key of lines) c[key] = (c[key] ?? 0) + 1
    }
    return c
  }, [serviceByLead])

  // Leads shown on the board — all of them, or just the active treatment.
  const visibleLeads = useMemo(
    () =>
      serviceFilter
        ? leads.filter((l) => (serviceByLead[l.id] ?? []).includes(serviceFilter))
        : leads,
    [leads, serviceFilter, serviceByLead]
  )

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  )

  const activeLead = activeId ? leads.find((l) => l.id === activeId) : null

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string)
  }, [])

  const moveLeadToStage = useCallback(
    async (leadId: string, newStageId: string) => {
      const lead = leads.find((l) => l.id === leadId)
      if (!lead || lead.stage_id === newStageId) return

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

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      setActiveId(null)
      if (!over) return
      void moveLeadToStage(active.id as string, over.id as string)
    },
    [moveLeadToStage]
  )

  // One-click approval of an AI-suggested stage move (suggest → approve).
  const handleApplySuggestion = useCallback(
    (leadId: string, toStageId: string) => {
      void moveLeadToStage(leadId, toStageId)
    },
    [moveLeadToStage]
  )

  // Treatment filter chips — only services with leads get a chip. Mirrors GHL's
  // "switch pipeline" but over one shared funnel. Rendered above the board.
  const chipRow = (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <ServiceChip
        label="All"
        count={leads.length}
        active={serviceFilter === null}
        onClick={() => setServiceFilter(null)}
      />
      {SERVICE_LINES.filter((s) => (serviceCounts[s.key] ?? 0) > 0).map((s) => (
        <ServiceChip
          key={s.key}
          label={s.label}
          count={serviceCounts[s.key]}
          active={serviceFilter === s.key}
          onClick={() => setServiceFilter((cur) => (cur === s.key ? null : s.key))}
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
            const stageLeads = visibleLeads.filter((l) => l.stage_id === stage.id)
            return (
              <PipelineColumn key={stage.id} stage={stage} leads={stageLeads} onLeadClick={(id) => router.push(`/leads/${id}`)} probabilityByLead={probabilityByLead} suggestionByLead={suggestionByLead} />
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
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      {chipRow}
      <div className="flex gap-3 overflow-x-auto pb-4 h-[calc(100vh-16rem)]">
        {stages
          .filter((s) => !s.is_lost)
          .map((stage) => {
            const stageLeads = visibleLeads.filter((l) => l.stage_id === stage.id)
            return (
              <PipelineColumn
                key={stage.id}
                stage={stage}
                leads={stageLeads}
                onLeadClick={(id) => router.push(`/leads/${id}`)}
                probabilityByLead={probabilityByLead}
                suggestionByLead={suggestionByLead}
                onApplySuggestion={handleApplySuggestion}
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
