'use client'

/**
 * ClosingBoard — the In-Closing deals surface (`/closing`).
 *
 * A read-mostly lens on leads already in the treatment-presented + financing
 * stages: case value, days since contact, and AI close probability all come
 * straight from the pipeline. The only writes are the two fields the old "Case
 * Follow ups" spreadsheet carried — a closing temperature override and a
 * next-step note — PATCHed to /api/leads/[id]/closing.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Lead } from '@/types/database'
import { LeadActions } from './lead-actions'
import type { ClosingTemperature } from '@/lib/pipeline/closing'

export type ClosingMeta = {
  closeProbability: number
  daysSinceContact: number | null
  serviceLines: string[]
  stageName: string
  derivedTemperature: ClosingTemperature
}

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
  leads,
  meta,
  forecast,
}: {
  leads: Lead[]
  meta: Record<string, ClosingMeta>
  forecast: ClosingForecast
}) {
  const router = useRouter()
  // Local override state so edits reflect instantly (optimistic).
  const [temps, setTemps] = useState<Record<string, ClosingTemperature | null>>(
    () => Object.fromEntries(leads.map((l) => [l.id, l.closing_temperature ?? null]))
  )
  const [steps, setSteps] = useState<Record<string, string>>(
    () => Object.fromEntries(leads.map((l) => [l.id, l.closing_next_step ?? '']))
  )
  const [editingStep, setEditingStep] = useState<string | null>(null)

  async function save(id: string, body: { temperature?: ClosingTemperature | null; nextStep?: string | null }) {
    try {
      await fetch(`/api/leads/${id}/closing`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      /* optimistic — a failed write just won't persist; page reload re-syncs */
    }
  }

  if (leads.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-aurea-border bg-aurea-card px-6 py-16 text-center">
        <p className="text-[15px] font-medium text-aurea-ink">No deals in closing right now</p>
        <p className="mt-1 text-[13px] text-aurea-ink-2">
          Deals appear here once they reach the Treatment Presented or Financing stage.
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
              <th className="px-4 py-3 font-medium">Stage</th>
              <th className="px-4 py-3 text-right font-medium">Last contact</th>
              <th className="px-4 py-3 text-right font-medium">Close&nbsp;%</th>
              <th className="px-4 py-3 font-medium">Temperature</th>
              <th className="px-4 py-3 font-medium">Next step</th>
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => {
              const m = meta[lead.id]
              const temp = temps[lead.id] ?? m.derivedTemperature
              const style = TEMP_STYLE[temp]
              const isOverride = temps[lead.id] != null
              const days = m.daysSinceContact
              return (
                <tr key={lead.id} className="border-b border-aurea-border/60 last:border-0 hover:bg-aurea-surface-2/40">
                  <td className="px-4 py-3">
                    <button
                      onClick={() => router.push(`/leads/${lead.id}`)}
                      className="font-medium text-aurea-ink hover:text-aurea-primary"
                    >
                      {lead.first_name} {lead.last_name}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-aurea-ink-2 capitalize">
                    {m.serviceLines.length ? m.serviceLines.join(', ').replace(/_/g, ' ') : '—'}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-aurea-ink">
                    {lead.treatment_value ? usd(lead.treatment_value) : '—'}
                  </td>
                  <td className="px-4 py-3 text-aurea-ink-2">{m.stageName}</td>
                  <td className="px-4 py-3 text-right text-aurea-ink-2">
                    {days === null ? 'never' : days === 0 ? 'today' : `${days}d ago`}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-aurea-ink">
                    {Math.round(m.closeProbability * 100)}%
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: style.dot }} />
                      <select
                        value={temp}
                        onChange={(e) => {
                          const val = e.target.value as ClosingTemperature
                          setTemps((s) => ({ ...s, [lead.id]: val }))
                          save(lead.id, { temperature: val })
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
                    {editingStep === lead.id ? (
                      <input
                        autoFocus
                        defaultValue={steps[lead.id]}
                        onBlur={(e) => {
                          const v = e.target.value
                          setSteps((s) => ({ ...s, [lead.id]: v }))
                          setEditingStep(null)
                          save(lead.id, { nextStep: v || null })
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
                        onClick={() => setEditingStep(lead.id)}
                        className="max-w-[240px] truncate text-left text-[12px] text-aurea-ink-2 hover:text-aurea-ink"
                      >
                        {steps[lead.id] || <span className="text-aurea-ink-3">Add next step…</span>}
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <LeadActions lead={lead} variant="compact" />
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
