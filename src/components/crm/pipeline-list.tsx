'use client'

import { useCallback, useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { toast } from 'sonner'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react'
import { StageSelect } from './stage-select'
import { EngagementMeter } from './engagement-meter'
import { LeadActions } from './lead-actions'
import { leadDisplayName, leadInitials } from '@/lib/leads/display-name'
import { displaySourceLabel, formatCampaignAttribution } from '@/lib/attribution'
import type { Lead, PipelineStage } from '@/types/database'

/**
 * The Pipeline's spreadsheet view — the same funnel the kanban shows, rendered
 * as a sortable, paginated table.
 *
 * Unlike the board (a capped ≤80-card slice per stage), this is fed by ONE
 * whole-book query, so every lead in the funnel is reachable by paging. Sort and
 * page state live in the URL and are resolved server-side; this component never
 * re-sorts locally, or page 2 would sort only page 2.
 *
 * Deliberately NOT the /leads table: that surface owns the whole book with its
 * facet filters, while this one is scoped to the pre-close funnel and carries
 * pipeline-specific columns (close probability, inline stage move). Sharing one
 * component would mean bending a 500-line filter UI around two different
 * populations.
 */
export function PipelineList({
  leads: initialLeads,
  stages,
  total,
  page,
  perPage,
  probabilityByLead,
}: {
  leads: Lead[]
  /** Board (pre-close) stages — the options offered by the inline stage picker. */
  stages: PipelineStage[]
  /** Exact whole-book total for this filter, for pagination + the count line. */
  total: number
  page: number
  perPage: number
  probabilityByLead?: Record<string, number>
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [leads, setLeads] = useState(initialLeads)
  // Rows mid-PATCH — their picker is disabled so a double-move can't race.
  const [pending, setPending] = useState<Record<string, boolean>>({})

  // A new server page (sort, filter, or pagination change) replaces local state
  // wholesale; any optimistic edit it contains has already been persisted.
  useEffect(() => { setLeads(initialLeads) }, [initialLeads])

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const params = new URLSearchParams(searchParams.toString())
      if (value) params.set(key, value)
      else params.delete(key)
      router.push(`/pipeline?${params.toString()}`)
    },
    [router, searchParams]
  )

  const activeSort = searchParams.get('sort') || 'created'
  const activeDir = searchParams.get('dir') || 'desc'

  // First click sorts descending (ascending for name, where A→Z is the useful
  // default); clicking the active column flips direction. Mirrors the /leads
  // table so the two spreadsheets behave identically.
  const toggleSort = useCallback(
    (key: string) => {
      const params = new URLSearchParams(searchParams.toString())
      if (activeSort === key) {
        params.set('dir', activeDir === 'asc' ? 'desc' : 'asc')
      } else {
        params.set('sort', key)
        params.set('dir', key === 'name' ? 'asc' : 'desc')
      }
      params.set('page', '1')
      router.push(`/pipeline?${params.toString()}`)
    },
    [activeSort, activeDir, router, searchParams]
  )

  /**
   * Inline stage move. Optimistic + toast + revert-on-failure, exactly like the
   * board's drag path — and like it, no router.refresh(): re-running the page's
   * queries would re-sort and re-paginate the table out from under whoever just
   * used the dropdown.
   */
  const changeStage = useCallback(
    async (leadId: string, stageId: string) => {
      const lead = leads.find((l) => l.id === leadId)
      if (!lead || lead.stage_id === stageId) return
      setPending((p) => ({ ...p, [leadId]: true }))
      setLeads((prev) =>
        prev.map((l) => (l.id === leadId ? { ...l, stage_id: stageId } : l))
      )
      try {
        const res = await fetch(`/api/leads/${leadId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage_id: stageId }),
        })
        if (!res.ok) throw new Error('Failed to update')
        const to = stages.find((s) => s.id === stageId)
        toast.success(`Moved to ${to?.name ?? 'new stage'}`)
      } catch {
        setLeads((prev) =>
          prev.map((l) => (l.id === leadId ? { ...l, stage_id: lead.stage_id } : l))
        )
        toast.error('Failed to move lead')
      } finally {
        setPending((p) => {
          const next = { ...p }
          delete next[leadId]
          return next
        })
      }
    },
    [leads, stages]
  )

  function SortableHead({
    label,
    sortKey,
    className,
  }: {
    label: string
    sortKey: string
    className?: string
  }) {
    const isActive = activeSort === sortKey
    return (
      <TableHead
        aria-sort={isActive ? (activeDir === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={`aurea-eyebrow cursor-pointer select-none text-aurea-ink-3 transition-colors hover:text-aurea-ink ${className || ''}`}
        onClick={() => toggleSort(sortKey)}
      >
        <span className="inline-flex items-center gap-1">
          {label}
          {isActive &&
            (activeDir === 'asc' ? (
              <ArrowUp className="h-3 w-3" strokeWidth={1.75} />
            ) : (
              <ArrowDown className="h-3 w-3" strokeWidth={1.75} />
            ))}
        </span>
      </TableHead>
    )
  }

  const totalPages = Math.max(1, Math.ceil(total / perPage))

  if (leads.length === 0) {
    return (
      <div className="aurea-card p-12 text-center">
        <p className="text-[14px] text-aurea-ink-2">No leads in the funnel for this filter.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="aurea-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="border-b border-aurea-border hover:bg-transparent">
              <SortableHead label="Lead" sortKey="name" />
              <TableHead className="aurea-eyebrow w-[190px] text-aurea-ink-3">Stage</TableHead>
              <SortableHead label="Engagement" sortKey="engagement" />
              <TableHead className="aurea-eyebrow text-aurea-ink-3">Close</TableHead>
              <TableHead className="aurea-eyebrow text-aurea-ink-3">Source</TableHead>
              <SortableHead label="Value" sortKey="value" />
              <SortableHead label="Last contact" sortKey="activity" />
              <SortableHead label="Created" sortKey="created" />
              <TableHead className="aurea-eyebrow text-right text-aurea-ink-3">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leads.map((lead) => {
              const probability = probabilityByLead?.[lead.id]
              const campaignLine = formatCampaignAttribution(lead.campaign_attribution)
              return (
                <TableRow
                  key={lead.id}
                  className="border-b border-aurea-border transition-colors last:border-0 hover:bg-aurea-surface-2"
                >
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-aurea-surface-2 text-[11px] font-semibold text-aurea-ink-2 ring-1 ring-aurea-border">
                        {leadInitials(lead)}
                      </span>
                      <div>
                        <p className="text-[14px] font-medium text-aurea-ink">
                          <Link
                            href={`/leads/${lead.id}`}
                            className="outline-none hover:underline focus-visible:underline"
                          >
                            {leadDisplayName(lead)}
                          </Link>
                        </p>
                        <p className="font-mono text-[11px] text-aurea-ink-3">
                          {lead.email || lead.phone}
                        </p>
                      </div>
                    </div>
                  </TableCell>

                  {/* The list's answer to dragging a card: same PATCH, same
                      optimistic behavior, one dropdown. */}
                  <TableCell>
                    <StageSelect
                      stages={stages}
                      value={lead.stage_id}
                      onChange={(stageId) => void changeStage(lead.id, stageId)}
                      disabled={pending[lead.id]}
                      size="sm"
                      aria-label={`Stage for ${leadDisplayName(lead)}`}
                    />
                  </TableCell>

                  <TableCell>
                    <EngagementMeter
                      temperature={lead.engagement_temperature}
                      score={lead.engagement_score}
                    />
                  </TableCell>

                  <TableCell>
                    {probability != null ? (
                      <span className="font-mono text-[12px] tabular-nums text-aurea-ink-2">
                        {Math.round(probability * 100)}%
                      </span>
                    ) : (
                      <span className="font-mono text-[11px] text-aurea-ink-3">—</span>
                    )}
                  </TableCell>

                  <TableCell>
                    <div className="flex flex-col">
                      <span className="text-[13px] capitalize text-aurea-ink-3">
                        {displaySourceLabel(
                          lead.source_type,
                          lead.campaign_attribution?.channel
                        )?.replace(/_/g, ' ') || '—'}
                      </span>
                      {campaignLine && (
                        <span
                          className="max-w-[200px] truncate font-mono text-[11px] text-aurea-ink-2"
                          title={campaignLine}
                        >
                          {campaignLine}
                        </span>
                      )}
                    </div>
                  </TableCell>

                  <TableCell>
                    {lead.treatment_value ? (
                      <span className="font-mono text-[13px] font-medium tabular-nums text-aurea-primary">
                        ${lead.treatment_value.toLocaleString()}
                      </span>
                    ) : (
                      <span className="font-mono text-[11px] text-aurea-ink-3">—</span>
                    )}
                  </TableCell>

                  <TableCell>
                    <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3">
                      {lead.last_contacted_at
                        ? formatDistanceToNow(new Date(lead.last_contacted_at), { addSuffix: true })
                        : 'never'}
                    </span>
                  </TableCell>

                  <TableCell>
                    <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3">
                      {formatDistanceToNow(new Date(lead.created_at), { addSuffix: true })}
                    </span>
                  </TableCell>

                  <TableCell className="text-right">
                    <div className="flex justify-end">
                      <LeadActions lead={lead} variant="compact" />
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <p className="font-mono text-[12px] tabular-nums text-aurea-ink-3">
          Showing {(page - 1) * perPage + 1}–{Math.min(page * perPage, total)} of{' '}
          {total.toLocaleString()}
        </p>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              aria-label="Previous page"
              onClick={() => setParam('page', String(page - 1))}
            >
              <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
            </Button>
            <span className="font-mono text-[12px] tabular-nums text-aurea-ink-2">
              {page} / {totalPages.toLocaleString()}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              aria-label="Next page"
              onClick={() => setParam('page', String(page + 1))}
            >
              <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
