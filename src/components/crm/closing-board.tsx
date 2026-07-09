'use client'

/**
 * ClosingBoard — the In-Closing deals surface (`/closing`).
 *
 * Renders the `closing_book` table: the curated "Case Follow ups" deals the
 * practice is working to close, seeded from its spreadsheet (NOT a pipeline
 * stage query — those stages are full of stale GHL labels). Case value, status,
 * strategy and gut-feel temperature all come from the sheet. The only writes are
 * the two inline-editable fields — a closing-temperature override and a
 * next-step note — PATCHed to /api/closing/[id].
 *
 * A row links to a CRM lead (for Call/SMS/Email + the lead detail page) only
 * when the sheet name matched exactly one lead; otherwise it shows read-only.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { LeadActions } from './lead-actions'
import type { ClosingTemperature } from '@/lib/pipeline/closing'
import type { ClosingRow } from '@/lib/pipeline/closing-book'

type ClosingForecast = {
  count: number
  totalValue: number
  weightedValue: number
  avgDaysSinceContact: number | null
}

const TEMP_STYLE: Record<ClosingTemperature, { dot: string; label: string; text: string }> = {
  hot: { dot: '#f43f5e', label: 'Hot', text: 'text-rose-600' },
  warm: { dot: '#f59e0b', label: 'Warm', text: 'text-amber-600' },
  cold: { dot: '#38bdf8', label: 'Cold', text: 'text-sky-600' },
  stalled: { dot: '#94a3b8', label: 'Stalled', text: 'text-aurea-ink-3' },
}
const TEMP_ORDER: ClosingTemperature[] = ['hot', 'warm', 'cold', 'stalled']

const usd = (n: number) => `$${Math.round(n).toLocaleString()}`

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-aurea-border bg-aurea-card px-4 py-3">
      <p className="aurea-eyebrow text-aurea-ink-3">{label}</p>
      <p className="mt-1 text-[22px] font-semibold text-aurea-ink">{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-aurea-ink-3">{hint}</p> : null}
    </div>
  )
}

export function ClosingBoard({
  rows,
  forecast,
}: {
  rows: ClosingRow[]
  forecast: ClosingForecast
}) {
  const router = useRouter()
  // Local override state so edits reflect instantly (optimistic).
  const [temps, setTemps] = useState<Record<string, ClosingTemperature | null>>(
    () => Object.fromEntries(rows.map((r) => [r.id, r.temperature ?? null]))
  )
  const [steps, setSteps] = useState<Record<string, string>>(
    () => Object.fromEntries(rows.map((r) => [r.id, r.nextStep ?? '']))
  )
  const [editingStep, setEditingStep] = useState<string | null>(null)

  async function save(id: string, body: { temperature?: ClosingTemperature | null; nextStep?: string | null }) {
    try {
      await fetch(`/api/closing/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      /* optimistic — a failed write just won't persist; page reload re-syncs */
    }
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-aurea-border bg-aurea-card px-6 py-16 text-center">
        <p className="text-[15px] font-medium text-aurea-ink">No deals in the closing book yet</p>
        <p className="mt-1 text-[13px] text-aurea-ink-2">
          This board is your curated closing list. Deals are added here as they’re worked to close.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Deals in closing" value={String(forecast.count)} />
        <StatCard label="Case value on table" value={usd(forecast.totalValue)} />
        <StatCard
          label="Weighted forecast"
          value={usd(forecast.weightedValue)}
          hint="Σ case value × close probability"
        />
        <StatCard
          label="Avg days since contact"
          value={forecast.avgDaysSinceContact === null ? '—' : String(forecast.avgDaysSinceContact)}
        />
      </div>

      <div className="overflow-x-auto rounded-lg border border-aurea-border bg-aurea-card">
        <table className="w-full min-w-[980px] text-left text-[13px]">
          <thead>
            <tr className="border-b border-aurea-border text-aurea-ink-3">
              <th className="px-4 py-3 font-medium">Patient</th>
              <th className="px-4 py-3 font-medium">Service</th>
              <th className="px-4 py-3 text-right font-medium">Case value</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Last contact</th>
              <th className="px-4 py-3 text-right font-medium">Close&nbsp;%</th>
              <th className="px-4 py-3 font-medium">Temperature</th>
              <th className="px-4 py-3 font-medium">Next step</th>
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const temp = temps[row.id] ?? row.derivedTemperature
              const style = TEMP_STYLE[temp]
              const isOverride = temps[row.id] != null
              const days = row.daysSinceContact
              const name = `${row.firstName} ${row.lastName}`.trim() || 'Unnamed'
              return (
                <tr key={row.id} className="border-b border-aurea-border/60 last:border-0 hover:bg-aurea-surface-2/40">
                  <td className="px-4 py-3">
                    {row.leadId ? (
                      <button
                        onClick={() => router.push(`/leads/${row.leadId}`)}
                        className="font-medium text-aurea-ink hover:text-aurea-primary"
                      >
                        {name}
                      </button>
                    ) : (
                      <span className="font-medium text-aurea-ink" title="No matching CRM lead — add contact info to enable call/text/email">
                        {name}
                      </span>
                    )}
                    {row.won ? (
                      <span className="ml-2 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600">
                        Closed
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-aurea-ink-2 capitalize">
                    {row.service?.trim() ? row.service.trim() : '—'}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-aurea-ink">
                    {row.caseValue ? usd(row.caseValue) : '—'}
                  </td>
                  <td className="px-4 py-3 text-aurea-ink-2">
                    {row.statusRaw?.trim() ? row.statusRaw.trim() : '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-aurea-ink-2">
                    {days === null ? 'never' : days === 0 ? 'today' : `${days}d ago`}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-aurea-ink">
                    {Math.round(row.closeProbability * 100)}%
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: style.dot }} />
                      <select
                        value={temp}
                        onChange={(e) => {
                          const val = e.target.value as ClosingTemperature
                          setTemps((s) => ({ ...s, [row.id]: val }))
                          save(row.id, { temperature: val })
                        }}
                        className={`bg-transparent text-[12px] font-medium ${style.text} focus:outline-none`}
                      >
                        {TEMP_ORDER.map((t) => (
                          <option key={t} value={t}>
                            {TEMP_STYLE[t].label}
                          </option>
                        ))}
                      </select>
                      {!isOverride ? <span className="text-[10px] text-aurea-ink-3">auto</span> : null}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {editingStep === row.id ? (
                      <input
                        autoFocus
                        defaultValue={steps[row.id]}
                        onBlur={(e) => {
                          const v = e.target.value
                          setSteps((s) => ({ ...s, [row.id]: v }))
                          setEditingStep(null)
                          save(row.id, { nextStep: v || null })
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                          if (e.key === 'Escape') setEditingStep(null)
                        }}
                        placeholder="e.g. offered 3rd-party financing"
                        className="w-56 rounded border border-aurea-border bg-aurea-surface-2 px-2 py-1 text-[12px] text-aurea-ink focus:outline-none"
                      />
                    ) : (
                      <button
                        onClick={() => setEditingStep(row.id)}
                        className="max-w-[240px] truncate text-left text-[12px] text-aurea-ink-2 hover:text-aurea-ink"
                      >
                        {steps[row.id] || <span className="text-aurea-ink-3">Add next step…</span>}
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {row.lead ? (
                      <LeadActions lead={row.lead} variant="compact" />
                    ) : (
                      <span className="text-[11px] text-aurea-ink-3">No linked contact</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
