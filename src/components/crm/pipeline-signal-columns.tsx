'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronDown, ChevronRight, Activity } from 'lucide-react'
import { LeadCard } from './lead-card'
import type { Lead } from '@/types/database'

export interface SignalColumn {
  key: string
  label: string
  description: string
  /** Exact whole-book count for this signal (treatment-scoped server-side). */
  count: number
  /** Capped card slice — the top leads by ai_score matching the signal. */
  leads: Lead[]
  /** Deep-link into /leads filtered to this exact signal (+ active treatment). */
  href: string
}

/**
 * The "By signal" strip above the drag board. Each column is a live lens
 * (Untouched / Active Communication / Financially Unqualified) computed from real
 * lead activity rather than the stale GHL stage label. Read-only by design: cards
 * open the lead, but there is no drop target — the stage board below owns moves.
 *
 * Collapsed by default: this is a reference lens, not the workspace. Expanded it
 * is a ~470px wall of cards that pushes the drag board — the thing staff actually
 * work — below the fold. The header keeps every count visible, so collapsing
 * costs no information; only the card previews are behind the toggle.
 */
export function PipelineSignalColumns({ columns }: { columns: SignalColumn[] }) {
  const router = useRouter()
  const [collapsed, setCollapsed] = useState(true)

  // Nothing to say if every signal is empty (e.g. a treatment filter with no hits).
  if (!columns.some((c) => c.count > 0)) return null

  return (
    <section className="mb-6 rounded-xl border border-aurea-border bg-aurea-surface">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-2 text-left"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-aurea-surface-2 text-aurea-ink-2">
            <Activity className="h-4 w-4" strokeWidth={1.75} />
          </span>
          <span className="text-[14px] font-medium text-aurea-ink">By signal</span>
          {collapsed ? (
            <ChevronRight className="h-4 w-4 text-aurea-ink-2" />
          ) : (
            <ChevronDown className="h-4 w-4 text-aurea-ink-2" />
          )}
        </button>

        {/* Counts stay on the header so the collapsed state still answers
            "how many are untouched?" without a click. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {columns.map((col) => (
            <Link
              key={col.key}
              href={col.href}
              className="flex items-center gap-1.5 text-[12px] text-aurea-ink-2 transition-colors hover:text-aurea-ink"
              title={col.description}
            >
              <span>{col.label}</span>
              <span className="font-mono tabular-nums text-aurea-ink-3">
                {col.count.toLocaleString()}
              </span>
            </Link>
          ))}
        </div>
      </header>

      {!collapsed && (
      <div className="flex gap-3 overflow-x-auto px-4 pb-4">
        {columns.map((col) => (
          <div
            key={col.key}
            className="flex w-72 shrink-0 flex-col rounded-lg border border-aurea-border bg-aurea-surface"
          >
            <div className="border-b border-aurea-border px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="aurea-eyebrow leading-none">{col.label}</span>
                <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3">
                  {col.count.toLocaleString()}
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-snug text-aurea-ink-3">{col.description}</p>
            </div>

            <div className="max-h-[420px] flex-1 space-y-2 overflow-y-auto p-2">
              {col.leads.map((lead) => (
                <LeadCard key={lead.id} lead={lead} onClick={() => router.push(`/leads/${lead.id}`)} />
              ))}

              {col.count > col.leads.length && (
                <div className="px-1 py-1 text-[10px] uppercase tracking-wide text-aurea-ink-3">
                  showing {col.leads.length} of {col.count.toLocaleString()}
                </div>
              )}

              {col.count === 0 && (
                <div className="flex h-20 items-center justify-center rounded-lg border border-dashed border-aurea-border text-[11px] text-aurea-ink-3">
                  None
                </div>
              )}
            </div>

            {col.count > 0 && (
              <Link
                href={col.href}
                className="border-t border-aurea-border px-3 py-2 text-[12px] text-aurea-ink-2 transition-colors hover:text-aurea-ink"
              >
                View all {col.count.toLocaleString()} →
              </Link>
            )}
          </div>
        ))}
      </div>
      )}
    </section>
  )
}
