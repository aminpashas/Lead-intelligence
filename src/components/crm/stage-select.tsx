'use client'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { PipelineStage } from '@/types/database'

/**
 * The one way to pick a pipeline stage. Rendered by the lead Details tab, the
 * conversation thread's toolbar, and its Lead Summary rail — so a stage reads
 * and moves identically wherever staff happen to be standing.
 *
 * Purely presentational: it reports the chosen stage id and leaves the write
 * (and any optimistic bookkeeping) to the caller, since the surfaces disagree
 * about what should happen after — the thread reverts on failure, the Details
 * tab refreshes.
 */
export function StageSelect({
  stages,
  value,
  onChange,
  disabled = false,
  size = 'default',
  variant = 'default',
  className,
  placeholder = 'Select stage',
  'aria-label': ariaLabel = 'Pipeline stage',
}: {
  stages: PipelineStage[]
  value: string | null | undefined
  onChange: (stageId: string) => void
  disabled?: boolean
  size?: 'sm' | 'default'
  /**
   * 'pill' renders a prominent, color-tinted status badge that IS the picker —
   * the current stage is unmissable and one click changes it. Used wherever the
   * lead's status must read at a glance (the conversation header). 'default' is
   * the plain dropdown used inside the Details panel + summary rail.
   */
  variant?: 'default' | 'pill'
  className?: string
  placeholder?: string
  'aria-label'?: string
}) {
  const selectedStage = stages.find((s) => s.id === value)
  const color = selectedStage?.color || null
  // Tint the pill with the stage's own color so each status is visually distinct.
  const pillStyle =
    variant === 'pill' && color
      ? { backgroundColor: `${color}1A`, borderColor: `${color}66` }
      : undefined

  return (
    // Base UI hands back `string | null`; clearing isn't offered here (a lead is
    // always somewhere in the funnel), so a null selection is simply ignored.
    <Select value={value || ''} onValueChange={(next) => next && onChange(next)} disabled={disabled}>
      <SelectTrigger
        size={size}
        style={pillStyle}
        className={cn(
          variant === 'pill'
            ? 'h-auto w-fit rounded-full border py-1 pl-2.5 pr-2 text-[13px] font-semibold text-aurea-ink shadow-none'
            : 'w-full',
          className
        )}
        aria-label={ariaLabel}
      >
        <SelectValue placeholder={placeholder}>
          {(selected) => {
            const stage = stages.find((s) => s.id === selected)
            return stage ? <StageLabel stage={stage} prominent={variant === 'pill'} /> : placeholder
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {stages.map((stage) => (
          <SelectItem key={stage.id} value={stage.id}>
            <StageLabel stage={stage} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * Read-only status badge — the same color-tinted pill the editable `pill`
 * variant renders, for surfaces that only DISPLAY the stage (the leads table).
 * Keeps status reading identically whether or not it can be changed in place.
 */
export function StageBadge({
  stage,
  className,
}: {
  stage: Pick<PipelineStage, 'name' | 'color'> | null | undefined
  className?: string
}) {
  if (!stage) return null
  const color = stage.color || null
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12.5px] font-semibold text-aurea-ink',
        className
      )}
      style={color ? { backgroundColor: `${color}1A`, borderColor: `${color}66` } : undefined}
    >
      {color && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />}
      <span className="truncate">{stage.name}</span>
    </span>
  )
}

function StageLabel({ stage, prominent = false }: { stage: PipelineStage; prominent?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {stage.color && (
        <span
          className={cn('shrink-0 rounded-full', prominent ? 'h-2 w-2' : 'h-1.5 w-1.5')}
          style={{ backgroundColor: stage.color }}
        />
      )}
      <span className="truncate">{stage.name}</span>
    </span>
  )
}
