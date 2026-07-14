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
 * A linked row is clickable straight into the patient's lead detail (Call / SMS
 * / Email + history + conversations); the interactive cells (temperature,
 * next-step, action bar) stop the click from bubbling. A row the seed couldn't
 * link — several patients or none shared the sheet name — shows a "Link patient"
 * chooser instead, to pick the right record or mint a new one.
 */

import { useState } from 'react'
import type { MouseEvent } from 'react'
import { useRouter } from 'next/navigation'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CheckCircle2, Loader2, UserPlus, UserRoundSearch } from 'lucide-react'
import { toast } from 'sonner'
import { LeadActions } from './lead-actions'
import type { ClosingTemperature } from '@/lib/pipeline/closing'
import type { ClosingRow } from '@/lib/pipeline/closing-book'

type Candidate = {
  id: string
  firstName: string
  lastName: string | null
  phoneLast4: string | null
  city: string | null
  state: string | null
  status: string | null
  lastContactedAt: string | null
}

/**
 * LinkPatient — resolve a closing row the seed left unlinked (no name match, or
 * several patients sharing the name). Lazily fetches candidates on open; the
 * staffer either links an existing patient or mints a fresh record. Either way
 * the row becomes clickable into the full lead detail, so we navigate there.
 */
function LinkPatient({ rowId, name }: { rowId: string; name: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [busy, setBusy] = useState(false)

  async function onOpenChange(next: boolean) {
    setOpen(next)
    if (next && candidates === null && !loading) {
      setLoading(true)
      try {
        const res = await fetch(`/api/closing/${rowId}/link`)
        const data = await res.json().catch(() => ({}))
        setCandidates(Array.isArray(data.candidates) ? data.candidates : [])
      } catch {
        setCandidates([])
      } finally {
        setLoading(false)
      }
    }
  }

  async function link(body: { leadId?: string; create?: true }) {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetch(`/api/closing/${rowId}/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.leadId) throw new Error(data?.error || 'Could not link patient')
      toast.success(body.create ? `Created a record for ${name}` : `Linked ${name}`)
      router.push(`/leads/${data.leadId}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not link patient')
      setBusy(false)
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        title="Link this deal to a patient record"
        className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-aurea-border px-2.5 text-[12px] font-medium text-aurea-ink-2 transition-colors hover:bg-aurea-surface-2 hover:text-aurea-ink"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} /> : <UserRoundSearch className="h-3.5 w-3.5" strokeWidth={1.75} />}
        Link patient
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Link “{name}” to a patient</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-aurea-ink-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} /> Finding patients…
          </div>
        ) : candidates && candidates.length > 0 ? (
          candidates.map((c) => {
            const place = [c.city, c.state].filter(Boolean).join(', ')
            const meta = [c.phoneLast4 ? `•••• ${c.phoneLast4}` : null, place || null]
              .filter(Boolean)
              .join(' · ')
            return (
              <DropdownMenuItem key={c.id} closeOnClick={false} onClick={() => link({ leadId: c.id })}>
                <div className="min-w-0">
                  <p className="truncate text-[13px] text-aurea-ink">
                    {c.firstName} {c.lastName ?? ''}
                  </p>
                  {meta ? <p className="truncate text-[11px] text-aurea-ink-3">{meta}</p> : null}
                </div>
              </DropdownMenuItem>
            )
          })
        ) : (
          <div className="px-2 py-2 text-[12px] text-aurea-ink-3">No matching patient found.</div>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem closeOnClick={false} onClick={() => link({ create: true })}>
          <UserPlus className="mr-2 h-4 w-4" strokeWidth={1.75} /> Create a new patient record
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
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
  deliberating: { dot: '#8b5cf6', label: 'Deliberating', text: 'text-violet-600' },
  cold: { dot: '#38bdf8', label: 'Cold', text: 'text-sky-600' },
  stalled: { dot: '#94a3b8', label: 'Stalled', text: 'text-aurea-ink-3' },
}
const TEMP_ORDER: ClosingTemperature[] = ['hot', 'warm', 'deliberating', 'cold', 'stalled']

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

  /** PATCH one field; returns whether the write persisted so callers can roll back their optimistic update. */
  async function save(id: string, body: { temperature?: ClosingTemperature | null; nextStep?: string | null }): Promise<boolean> {
    try {
      const res = await fetch(`/api/closing/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return res.ok
    } catch {
      return false
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
              const openLead = row.leadId ? () => router.push(`/leads/${row.leadId}`) : undefined
              // Keep clicks on the inline controls from triggering row navigation.
              const stop = (e: MouseEvent) => e.stopPropagation()
              return (
                <tr
                  key={row.id}
                  onClick={openLead}
                  className={`group border-b border-aurea-border/60 last:border-0 ${
                    row.won
                      ? 'bg-emerald-500/[0.06] hover:bg-emerald-500/[0.11]'
                      : 'hover:bg-aurea-surface-2/40'
                  } ${openLead ? 'cursor-pointer' : ''}`}
                >
                  <td
                    className={`whitespace-nowrap px-4 py-3 ${
                      row.won ? 'border-l-2 border-l-emerald-500' : ''
                    }`}
                  >
                    <span
                      className={`font-medium text-aurea-ink ${openLead ? 'group-hover:text-aurea-primary' : ''}`}
                      title={openLead ? undefined : 'Not yet linked to a patient — use “Link patient” to enable call/text/email'}
                    >
                      {name}
                    </span>
                    {row.won ? (
                      <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                        <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} />
                        Closed · Won
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
                  <td className="px-4 py-3" onClick={stop}>
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: style.dot }} />
                      <select
                        value={temp}
                        onChange={async (e) => {
                          const val = e.target.value as ClosingTemperature
                          const prev = temps[row.id] ?? null
                          setTemps((s) => ({ ...s, [row.id]: val })) // optimistic
                          if (!(await save(row.id, { temperature: val }))) {
                            setTemps((s) => ({ ...s, [row.id]: prev })) // revert
                            toast.error('Could not update temperature')
                          }
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
                  <td className="px-4 py-3" onClick={stop}>
                    {editingStep === row.id ? (
                      <input
                        autoFocus
                        defaultValue={steps[row.id]}
                        onBlur={async (e) => {
                          const v = e.target.value
                          const prev = steps[row.id] ?? ''
                          setSteps((s) => ({ ...s, [row.id]: v })) // optimistic
                          setEditingStep(null)
                          if (!(await save(row.id, { nextStep: v || null }))) {
                            setSteps((s) => ({ ...s, [row.id]: prev })) // revert
                            toast.error('Could not save next step')
                          }
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
                  <td className="px-4 py-3" onClick={stop}>
                    {row.lead ? (
                      <LeadActions lead={row.lead} variant="compact" />
                    ) : (
                      <LinkPatient rowId={row.id} name={name} />
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
