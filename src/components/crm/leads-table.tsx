'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search, X } from 'lucide-react'
import { TagBadgeList } from './tag-badge'
import { formatCampaignAttribution, displaySourceLabel } from '@/lib/attribution'
import type { Lead, PipelineStage, Tag } from '@/types/database'
import { LeadActions } from './lead-actions'
import { EngagementMeter } from './engagement-meter'
import { StageBadge } from './stage-select'
import { LEAD_DATE_RANGES } from '@/lib/leads/date-range'
import { leadDisplayName, leadInitials } from '@/lib/leads/display-name'
import { cn } from '@/lib/utils'
import { useState, type ReactNode } from 'react'


// Practice service lines — matched server-side against treatment_interest,
// ingestion tags, and campaign/UTM keywords (see leads/page.tsx).
const SERVICE_OPTIONS = [
  { value: 'implants', label: 'Implants / All-on-4' },
  { value: 'cosmetic', label: 'Cosmetic / Veneers' },
  { value: 'tmj', label: 'TMJ' },
  { value: 'sleep_apnea', label: 'Sleep Apnea' },
  { value: 'lanap', label: 'LANAP' },
]

type Facet = { value: string; count: number }

// Credit buckets stored on the lead (CreditRange). Titles the raw enum values
// for the dropdown; unknown values fall back to a capitalized display.
const CREDIT_LABELS: Record<string, string> = {
  excellent: 'Excellent',
  good: 'Good',
  fair: 'Fair',
  rebuilding: 'Rebuilding',
  unknown: 'Unknown',
}

export function LeadsTable({
  leads,
  stages,
  total,
  page,
  perPage,
  allTags,
  leadTagsMap,
  sourceFacets,
  campaignFacets,
  creditFacets,
}: {
  leads: Lead[]
  stages: PipelineStage[]
  total: number
  page: number
  perPage: number
  allTags?: Tag[]
  leadTagsMap?: Record<string, Tag[]>
  sourceFacets?: Facet[]
  campaignFacets?: Facet[]
  creditFacets?: Facet[]
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [search, setSearch] = useState(searchParams.get('search') || '')

  function updateFilters(key: string, value: string | null) {
    const params = new URLSearchParams(searchParams.toString())
    if (value && value !== 'all') {
      params.set(key, value)
    } else {
      params.delete(key)
    }
    params.set('page', '1')
    router.push(`/leads?${params.toString()}`)
  }

  function handleSearch() {
    updateFilters('search', search)
  }

  // Which filters are currently narrowing the list (search included).
  const FILTER_KEYS = ['search', 'range', 'qualification', 'status', 'service', 'source', 'credit', 'campaign', 'tag']
  const activeFilterCount = FILTER_KEYS.filter((k) => searchParams.get(k)).length

  // Reset every filter but keep the current sort — a clean slate, not a reload.
  function clearAll() {
    const params = new URLSearchParams()
    const sort = searchParams.get('sort')
    const dir = searchParams.get('dir')
    if (sort) params.set('sort', sort)
    if (dir) params.set('dir', dir)
    setSearch('')
    router.push(`/leads?${params.toString()}`)
  }

  /**
   * One filter dropdown. Base UI's <Select.Value> renders the raw value, so we
   * feed it an `items` map (value → trigger text). The category name is always
   * shown so you can tell what the filter does at a glance: idle reads "Source"
   * / "Status", and a set filter reads "Status: New" rather than a bare "New"
   * that gives no clue which column it narrows. A set filter is accent-tinted.
   */
  function FilterSelect({
    paramKey,
    label,
    allLabel,
    options,
    className,
  }: {
    paramKey: string
    label: string
    allLabel: string
    options: { value: string; row: ReactNode; text: string }[]
    className?: string
  }) {
    const current = searchParams.get(paramKey) || 'all'
    const active = current !== 'all'
    const items: Record<string, ReactNode> = { all: label }
    for (const o of options) {
      items[o.value] = (
        <span className="truncate">
          <span className="text-aurea-ink-3">{label}:</span> {o.text}
        </span>
      )
    }
    return (
      <Select items={items} value={current} onValueChange={(v) => updateFilters(paramKey, v)}>
        <SelectTrigger
          className={cn(
            'w-40',
            active && 'border-aurea-primary/40 bg-aurea-primary/5 font-medium text-aurea-primary',
            className
          )}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{allLabel}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.row}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }

  // Facet rows carry a muted count suffix; the trigger keeps just the label.
  const countRow = (label: ReactNode, count: number): ReactNode => (
    <span className="flex items-center gap-1.5">
      {label}
      <span className="text-aurea-ink-3">({count.toLocaleString()})</span>
    </span>
  )

  // Column-header sorting: first click sorts desc (asc for name), second
  // click flips direction. State lives in the URL like every other filter.
  const activeSort = searchParams.get('sort') || 'created'
  const activeDir = searchParams.get('dir') || 'desc'

  function toggleSort(key: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (activeSort === key) {
      params.set('dir', activeDir === 'asc' ? 'desc' : 'asc')
    } else {
      params.set('sort', key)
      params.set('dir', key === 'name' ? 'asc' : 'desc')
    }
    params.set('page', '1')
    router.push(`/leads?${params.toString()}`)
  }

  function SortableHead({ label, sortKey, className }: { label: string; sortKey: string; className?: string }) {
    const isActive = activeSort === sortKey
    return (
      <TableHead
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

  const totalPages = Math.ceil(total / perPage)

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[200px] max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-aurea-ink-3" strokeWidth={1.75} />
          <Input
            placeholder="Search name, email, or phone…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="pl-9"
          />
        </div>

        {/* Date range — filters on created_at (calendar days, practice tz) */}
        <FilterSelect
          paramKey="range"
          label="Date"
          allLabel="Any time"
          options={LEAD_DATE_RANGES.map((r) => ({ value: r.value, row: r.label, text: r.label }))}
        />

        {/* Behavioral engagement temperature (engagement_temperature). The old
            control filtered ai_qualification while CALLING it engagement — the
            two are different axes (quality vs. liveliness). ?qualification=…
            deep-links still work server-side. */}
        <FilterSelect
          paramKey="temp"
          label="Engagement"
          allLabel="Any engagement"
          options={[
            { value: 'hot', row: 'Hot', text: 'Hot' },
            { value: 'warm', row: 'Warm', text: 'Warm' },
            { value: 'cooling', row: 'Cooling', text: 'Cooling' },
            { value: 'new', row: 'New', text: 'New' },
            { value: 'cold', row: 'Cold', text: 'Cold' },
          ]}
        />

        <FilterSelect
          paramKey="status"
          label="Status"
          allLabel="All statuses"
          options={[
            { value: 'new', row: 'New', text: 'New' },
            { value: 'contacted', row: 'Contacted', text: 'Contacted' },
            { value: 'qualified', row: 'Qualified', text: 'Qualified' },
            { value: 'consultation_scheduled', row: 'Consult Scheduled', text: 'Consult Scheduled' },
            { value: 'treatment_presented', row: 'Treatment Presented', text: 'Treatment Presented' },
            { value: 'contract_signed', row: 'Contract Signed', text: 'Contract Signed' },
            { value: 'lost', row: 'Lost', text: 'Lost' },
          ]}
        />

        {/* Service line */}
        <FilterSelect
          paramKey="service"
          label="Service"
          allLabel="All services"
          className="w-44"
          options={SERVICE_OPTIONS.map((s) => ({ value: s.value, row: s.label, text: s.label }))}
        />

        {/* Lead source */}
        {sourceFacets && sourceFacets.length > 0 && (
          <FilterSelect
            paramKey="source"
            label="Source"
            allLabel="All sources"
            className="w-44"
            options={sourceFacets.map((f) => {
              const text = f.value.replace(/_/g, ' ')
              return { value: f.value, text, row: countRow(<span className="capitalize">{text}</span>, f.count) }
            })}
          />
        )}

        {/* Credit range — facet-gated: hidden until discovery captures credit
            data (empty across the imported book today). */}
        {creditFacets && creditFacets.length > 0 && (
          <FilterSelect
            paramKey="credit"
            label="Credit"
            allLabel="Any credit"
            className="w-44"
            options={creditFacets.map((f) => {
              const text = CREDIT_LABELS[f.value] ?? f.value
              return { value: f.value, text, row: countRow(text, f.count) }
            })}
          />
        )}

        {/* Campaign */}
        {campaignFacets && campaignFacets.length > 0 && (
          <FilterSelect
            paramKey="campaign"
            label="Campaign"
            allLabel="All campaigns"
            className="w-56"
            options={campaignFacets.map((f) => ({
              value: f.value,
              text: f.value,
              row: countRow(
                <span className="block max-w-[280px] truncate" title={f.value}>{f.value}</span>,
                f.count
              ),
            }))}
          />
        )}

        {/* Tag Filter */}
        {allTags && allTags.length > 0 && (
          <FilterSelect
            paramKey="tag"
            label="Tag"
            allLabel="All tags"
            className="w-44"
            options={allTags.map((tag) => ({
              value: tag.slug,
              text: tag.name,
              row: countRow(
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: tag.color }} />
                  {tag.name}
                </span>,
                tag.lead_count
              ),
            }))}
          />
        )}

        {/* Clear all — only once something is actually narrowing the list. */}
        {activeFilterCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearAll}
            className="h-8 gap-1.5 text-aurea-ink-3 hover:text-aurea-ink"
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.75} />
            Clear{activeFilterCount > 1 ? ` (${activeFilterCount})` : ''}
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="aurea-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-b border-aurea-border hover:bg-transparent">
              {/* All ten columns rendered at once meant a ~900px horizontal
                  swipe per row on a phone. Secondary columns drop out by
                  breakpoint, leaving Lead · Engagement · Actions — which fits
                  343px without scrolling. Each `hidden …:table-cell` here has a
                  matching class on its body cell below; they must stay in sync. */}
              <SortableHead label="Lead" sortKey="name" />
              <SortableHead label="Engagement" sortKey="score" />
              <TableHead className="aurea-eyebrow text-aurea-ink-3 hidden md:table-cell">Stage</TableHead>
              <TableHead className="aurea-eyebrow text-aurea-ink-3 hidden xl:table-cell">Tags</TableHead>
              <TableHead className="aurea-eyebrow text-aurea-ink-3 hidden xl:table-cell">Condition</TableHead>
              <TableHead className="aurea-eyebrow text-aurea-ink-3 hidden lg:table-cell">Source</TableHead>
              <SortableHead label="Activity" sortKey="activity" className="hidden lg:table-cell" />
              <SortableHead label="Value" sortKey="value" className="hidden md:table-cell" />
              <SortableHead label="Created" sortKey="created" className="hidden xl:table-cell" />
              <TableHead className="aurea-eyebrow text-aurea-ink-3 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leads.map((lead) => {
              const initials = leadInitials(lead)
              const tags = leadTagsMap?.[lead.id] || []
              // Exact campaign line ("Google Ads — Implants June") synced from
              // DGS; the bare source_type stays as the fallback label.
              const campaignLine = formatCampaignAttribution(lead.campaign_attribution)
              return (
                <TableRow
                  key={lead.id}
                  className="cursor-pointer border-b border-aurea-border transition-colors last:border-0 hover:bg-aurea-surface-2"
                  onClick={() => router.push(`/leads/${lead.id}`)}
                >
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-aurea-surface-2 text-[11px] font-semibold text-aurea-ink-2 ring-1 ring-aurea-border">
                        {initials}
                      </span>
                      <div>
                        <p className="text-[14px] font-medium text-aurea-ink">
                          {/* Real link so keyboard users can tab to and open a
                              lead; stopPropagation keeps the row click intact. */}
                          <Link
                            href={`/leads/${lead.id}`}
                            className="outline-none focus-visible:underline"
                            onClick={(e) => e.stopPropagation()}
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
                  <TableCell>
                    {/* Behavioral temperature (engagement sweep) — NOT the AI
                        quality grade, which lives on the lead detail page. */}
                    <EngagementMeter
                      temperature={lead.engagement_temperature}
                      score={lead.engagement_score}
                    />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <StageBadge stage={lead.pipeline_stage} />
                  </TableCell>
                  <TableCell className="hidden xl:table-cell">
                    {tags.length > 0 ? (
                      <TagBadgeList tags={tags} maxVisible={2} compact />
                    ) : (
                      <span className="font-mono text-[11px] text-aurea-ink-3">—</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden xl:table-cell">
                    <span className="text-[13px] text-aurea-ink-2 capitalize">
                      {lead.dental_condition?.replace(/_/g, ' ') || '—'}
                    </span>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <div className="flex flex-col">
                      <span className="text-[13px] text-aurea-ink-3 capitalize">
                        {displaySourceLabel(lead.source_type, lead.campaign_attribution?.channel)?.replace(/_/g, ' ') || '—'}
                      </span>
                      {campaignLine && (
                        <span
                          className="max-w-[220px] truncate font-mono text-[11px] text-aurea-ink-2"
                          title={campaignLine}
                        >
                          {campaignLine}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <span className="font-mono text-[12px] tabular-nums text-aurea-ink-3">
                      {lead.total_messages_sent + lead.total_messages_received} msgs
                    </span>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {lead.treatment_value ? (
                      <span className="font-mono text-[13px] font-medium tabular-nums text-aurea-primary">
                        ${lead.treatment_value.toLocaleString()}
                      </span>
                    ) : (
                      <span className="font-mono text-[11px] text-aurea-ink-3">—</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden xl:table-cell">
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

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="font-mono text-[12px] tabular-nums text-aurea-ink-3">
            Showing {(page - 1) * perPage + 1}–{Math.min(page * perPage, total)} of {total}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => updateFilters('page', String(page - 1))}
            >
              <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
            </Button>
            <span className="font-mono text-[12px] tabular-nums text-aurea-ink-2">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => updateFilters('page', String(page + 1))}
            >
              <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
