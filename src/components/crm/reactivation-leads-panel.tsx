'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2, Users, ExternalLink } from 'lucide-react'

type PanelLead = {
  id: string
  first_name: string | null
  last_name: string | null
  status: string | null
  ai_score: number | null
  ai_qualification: string | null
  last_contacted_at: string | null
  enrollment_status?: string
}

type Pagination = { page: number; per_page: number; total: number; total_pages: number }

const qualInk: Record<string, string> = {
  hot: 'text-aurea-primary',
  warm: 'text-aurea-gold',
  cold: 'text-aurea-ink-3',
  unqualified: 'text-aurea-ink-3',
}

function leadName(lead: PanelLead) {
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim()
  return name || 'Unnamed lead'
}

function lastTouch(iso: string | null) {
  if (!iso) return 'Never contacted'
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  if (days <= 0) return 'Today'
  if (days === 1) return '1 day ago'
  if (days < 60) return `${days} days ago`
  return `${Math.floor(days / 30)} months ago`
}

/**
 * Smart-list-style lead list for reactivation surfaces. Fetches from any
 * endpoint returning `{ leads, pagination }` (template audience preview or
 * campaign enrollments) and renders clickable rows into the lead detail page.
 */
export function ReactivationLeadsPanel({ endpoint }: { endpoint: string }) {
  const [leads, setLeads] = useState<PanelLead[]>([])
  const [pagination, setPagination] = useState<Pagination | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function fetchPage(page: number, append: boolean) {
    try {
      const res = await fetch(`${endpoint}?page=${page}&per_page=25`)
      if (!res.ok) throw new Error('Failed to load leads')
      const data = await res.json()
      setLeads((prev) => (append ? [...prev, ...data.leads] : data.leads))
      setPagination(data.pagination)
      setError(null)
    } catch {
      setError('Could not load leads')
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }

  useEffect(() => {
    setLoading(true)
    setLeads([])
    fetchPage(1, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint])

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-[12px] text-aurea-ink-3">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Finding matching leads…
      </div>
    )
  }

  if (error) {
    return <p className="py-4 text-center text-[12px] text-aurea-ink-3">{error}</p>
  }

  if (leads.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1.5 py-6 text-center">
        <Users className="h-4 w-4 text-aurea-ink-3" strokeWidth={1.75} />
        <p className="text-[12px] text-aurea-ink-3">No leads match this audience right now</p>
      </div>
    )
  }

  const hasMore = pagination ? pagination.page < pagination.total_pages : false

  return (
    <div>
      <div className="max-h-64 overflow-y-auto">
        {leads.map((lead) => (
          <Link
            key={lead.id}
            href={`/leads/${lead.id}`}
            className="group/lead flex items-center justify-between gap-3 border-b border-aurea-border px-1 py-2 last:border-0 hover:bg-aurea-surface-2"
          >
            <div className="min-w-0">
              <p className="truncate text-[12.5px] font-medium text-aurea-ink group-hover/lead:underline">
                {leadName(lead)}
              </p>
              <p className="mt-0.5 truncate text-[11px] text-aurea-ink-3">
                {(lead.enrollment_status
                  ? `Enrollment ${lead.enrollment_status.replace(/_/g, ' ')}`
                  : (lead.status || 'unknown').replace(/_/g, ' '))}
                <span className="text-aurea-border-strong"> · </span>
                {lastTouch(lead.last_contacted_at)}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {lead.ai_qualification && lead.ai_qualification !== 'unscored' && (
                <span className={`font-mono text-[10px] uppercase tracking-wide ${qualInk[lead.ai_qualification] || 'text-aurea-ink-3'}`}>
                  {lead.ai_qualification}
                </span>
              )}
              {typeof lead.ai_score === 'number' && (
                <span className="font-mono text-[11px] tabular-nums text-aurea-ink-2">{lead.ai_score}</span>
              )}
              <ExternalLink className="h-3 w-3 text-aurea-ink-3 opacity-0 transition-opacity group-hover/lead:opacity-100" strokeWidth={1.75} />
            </div>
          </Link>
        ))}
      </div>

      <div className="flex items-center justify-between pt-2">
        <p className="font-mono text-[10px] tabular-nums text-aurea-ink-3">
          {leads.length} of {pagination?.total.toLocaleString()} leads
        </p>
        {hasMore && (
          <button
            type="button"
            className="text-[11px] font-medium text-aurea-ink-2 hover:text-aurea-ink disabled:opacity-50"
            disabled={loadingMore}
            onClick={() => {
              setLoadingMore(true)
              fetchPage((pagination?.page || 1) + 1, true)
            }}
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </div>
  )
}
