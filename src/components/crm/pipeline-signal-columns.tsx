'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
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
 */
export function PipelineSignalColumns({ columns }: { columns: SignalColumn[] }) {
  const router = useRouter()

  // Nothing to say if every signal is empty (e.g. a treatment filter with no hits).
  if (!columns.some((c) => c.count > 0)) return null

  return (
    <section className="mb-6">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="aurea-eyebrow">By signal</h2>
        <span className="text-[12px] leading-snug text-aurea-ink-3">
          Live lenses from real activity — read-only, independent of the stage board below.
        </span>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2">
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
    </section>
  )
}
