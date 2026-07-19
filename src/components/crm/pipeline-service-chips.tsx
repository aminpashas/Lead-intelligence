'use client'

import { useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { SERVICE_LINES } from '@/lib/leads/service-line'

/**
 * Treatment filter chips for the Pipeline. Mirrors GHL's "switch pipeline" but
 * over one shared funnel.
 *
 * Lifted out of PipelineBoard so the Board and List views render the SAME
 * control: list mode doesn't mount the board, and a chip row that disappeared
 * when you switched views would strand staff with an invisible active filter.
 *
 * Counts are whole-book totals computed server-side, so the chips never
 * disagree with the funnel. Clicking one re-scopes the page via the URL —
 * a real round-trip, not a filter of the already-loaded sample.
 */
export function PipelineServiceChips({
  totalLeadCount = 0,
  serviceCounts = {},
  activeService = null,
}: {
  totalLeadCount?: number
  serviceCounts?: Record<string, number>
  activeService?: string | null
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  // Toggling the active chip (or "All") clears the filter. Every other param —
  // notably ?view — is preserved, so filtering doesn't kick you back to Board.
  const selectService = useCallback(
    (key: string | null) => {
      const params = new URLSearchParams(searchParams.toString())
      if (key && key !== activeService) params.set('service', key)
      else params.delete('service')
      // A treatment switch changes the population; page 2 of the old cohort is
      // meaningless against the new one.
      params.delete('page')
      const qs = params.toString()
      router.push(qs ? `/pipeline?${qs}` : '/pipeline')
    },
    [activeService, router, searchParams]
  )

  return (
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
        {count.toLocaleString()}
      </span>
    </button>
  )
}
