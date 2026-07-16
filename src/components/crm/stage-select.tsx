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
  className,
  placeholder = 'Select stage',
  'aria-label': ariaLabel = 'Pipeline stage',
}: {
  stages: PipelineStage[]
  value: string | null | undefined
  onChange: (stageId: string) => void
  disabled?: boolean
  size?: 'sm' | 'default'
  className?: string
  placeholder?: string
  'aria-label'?: string
}) {
  return (
    // Base UI hands back `string | null`; clearing isn't offered here (a lead is
    // always somewhere in the funnel), so a null selection is simply ignored.
    <Select value={value || ''} onValueChange={(next) => next && onChange(next)} disabled={disabled}>
      <SelectTrigger size={size} className={cn('w-full', className)} aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder}>
          {(selected) => {
            const stage = stages.find((s) => s.id === selected)
            return stage ? <StageLabel stage={stage} /> : placeholder
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

function StageLabel({ stage }: { stage: PipelineStage }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {stage.color && (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: stage.color }} />
      )}
      <span className="truncate">{stage.name}</span>
    </span>
  )
}
