'use client'

import { useMemo, useState } from 'react'
import type {
  LenderPrequalOffer, LenderSelection, LenderTermOption,
} from '@/lib/financing/prequal-types'
import { allocateCoverage } from '@/lib/financing/allocate-coverage'
import { computeSelectionTotals } from '@/lib/financing/selection-totals'
import { pickAffordableTerm } from '@/lib/financing/coverage-line'
import { generateAmortizationSchedule } from '@/lib/financing/calculator'

const money = (n: number) => `$${Math.round(n).toLocaleString()}`
const termKey = (t: LenderTermOption) => `${t.apr}:${t.term_months}:${t.promo_period_months}`
const termLabel = (t: LenderTermOption) =>
  t.promo_period_months > 0
    ? `0% · ${t.term_months}mo (promo)`
    : `${t.apr}% · ${t.term_months}mo`

type RowState = { on: boolean; amount: number; term: LenderTermOption }

/**
 * Interest saved by paying `extra` extra principal every month. Valid because
 * these loans have no prepayment penalty. Reuses the shared amortization engine
 * for the baseline, then simulates the accelerated payoff.
 */
function accelerate(
  amount: number, apr: number, termMonths: number, promoMonths: number, extra: number,
): { saved: number; monthsSaved: number } {
  const base = generateAmortizationSchedule(amount, apr, termMonths, promoMonths)
  const baseInterest = base.reduce((s, r) => s + r.interest, 0)
  const baseMonthly = base[0]?.payment ?? 0
  const monthlyRate = apr / 100 / 12
  let balance = amount, interest = 0, months = 0
  const pay = baseMonthly + extra
  while (balance > 0.01 && months < termMonths * 2) {
    const i = months < promoMonths ? 0 : balance * monthlyRate
    const principal = pay - i
    if (principal <= 0) break
    balance = Math.max(0, balance - principal)
    interest += i
    months++
  }
  return { saved: Math.max(0, Math.round(baseInterest - interest)), monthsSaved: Math.max(0, termMonths - months) }
}

export function PrequalResults({ treatmentTotal, offers, onProceed, proceedLabel }: {
  treatmentTotal: number
  offers: LenderPrequalOffer[]
  /** When provided, renders a "proceed" button that emits the current selection. */
  onProceed?: (args: { treatmentTotal: number; selections: LenderSelection[] }) => void
  proceedLabel?: string
}) {
  const approved = useMemo(() => offers.filter(o => o.decision === 'approved' && o.terms.length > 0), [offers])
  const others = useMemo(() => offers.filter(o => o.decision !== 'approved'), [offers])

  // Default selection = the recommended stacked plan (amount-first, longest term).
  const recommended = useMemo(() => allocateCoverage(treatmentTotal, approved), [treatmentTotal, approved])

  const [rows, setRows] = useState<Record<string, RowState>>(() => {
    const init: Record<string, RowState> = {}
    for (const offer of approved) {
      const line = recommended.lines.find(l => l.lender_slug === offer.lender_slug)
      const amount = line ? line.amount : Math.min(offer.approved_amount, treatmentTotal)
      init[offer.lender_slug] = { on: !!line, amount, term: pickAffordableTerm(offer, amount) }
    }
    return init
  })

  const setRow = (slug: string, patch: Partial<RowState>) =>
    setRows(prev => ({ ...prev, [slug]: { ...prev[slug], ...patch } }))

  const selections: LenderSelection[] = useMemo(() =>
    approved
      .filter(o => rows[o.lender_slug]?.on)
      .map(o => ({ offer: o, amount: rows[o.lender_slug].amount, term: rows[o.lender_slug].term })),
    [approved, rows])

  const totals = useMemo(() => computeSelectionTotals(selections, treatmentTotal), [selections, treatmentTotal])
  const coveredPct = treatmentTotal > 0 ? Math.min(100, (totals.covered / treatmentTotal) * 100) : 0

  // Acceleration: interest saved by paying $100/mo extra across the selected plan.
  const accel = useMemo(() => {
    let saved = 0, monthsSaved = 0
    for (const l of totals.lines) {
      const r = accelerate(l.amount, l.apr, l.term_months, l.promo_period_months, 100)
      saved += r.saved
      monthsSaved = Math.max(monthsSaved, r.monthsSaved)
    }
    return { saved: Math.round(saved), monthsSaved }
  }, [totals.lines])

  if (approved.length === 0 && others.length === 0) return null

  return (
    <div className="rounded-lg border border-aurea-border bg-aurea-surface p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="aurea-eyebrow text-aurea-ink-3">What you qualify for</p>
        <p className="text-[11px] text-aurea-ink-3">soft check · no score impact</p>
      </div>
      <p className="mb-2 text-[12px] text-aurea-ink-3">
        Treatment total <span className="font-mono tabular-nums font-medium text-aurea-ink">{money(treatmentTotal)}</span>
      </p>

      {/* Coverage bar */}
      <div className="mb-1.5 h-2.5 w-full overflow-hidden rounded-full bg-aurea-surface-2">
        <div
          className={`h-full ${totals.gap <= 0 ? 'bg-aurea-primary' : 'bg-aurea-amber'}`}
          style={{ width: `${coveredPct}%` }}
        />
      </div>
      <p className={`mb-3 text-[12px] font-medium ${totals.gap <= 0 ? 'text-aurea-primary' : 'text-aurea-amber'}`}>
        {totals.gap <= 0
          ? `Fully covered — ${money(totals.covered)} of ${money(treatmentTotal)}`
          : `${money(totals.covered)} covered · ${money(totals.gap)} remaining (cash / in-house)`}
      </p>

      {/* Selectable lender rows */}
      {approved.length > 0 && (
        <div className="space-y-1.5">
          {approved.map(offer => {
            const row = rows[offer.lender_slug]
            const monthly = totals.lines.find(l => l.lender_slug === offer.lender_slug)?.monthly_payment ?? 0
            return (
              <div
                key={offer.lender_slug}
                className={`rounded-lg border px-3 py-2 ${row.on ? 'border-aurea-primary/30 bg-aurea-primary/5' : 'border-aurea-border bg-aurea-surface-2'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={row.on}
                      onChange={e => setRow(offer.lender_slug, { on: e.target.checked })}
                      className="h-3.5 w-3.5 accent-aurea-primary"
                    />
                    <span className="text-[13px] font-medium text-aurea-ink">{offer.lender_name}</span>
                  </label>
                  <span className="font-mono text-[12px] tabular-nums text-aurea-ink-2">
                    {row.on && monthly > 0 ? `${money(monthly)}/mo` : ''}
                  </span>
                </div>
                {row.on && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-6">
                    <input
                      type="number"
                      value={row.amount}
                      min={0}
                      max={offer.approved_amount}
                      onChange={e => setRow(offer.lender_slug, { amount: Math.min(Number(e.target.value) || 0, offer.approved_amount) })}
                      className="w-24 rounded-md border border-aurea-border bg-aurea-surface px-2 py-1 font-mono text-[12px] tabular-nums text-aurea-ink"
                    />
                    <span className="text-[11px] text-aurea-ink-3">of {money(offer.approved_amount)}</span>
                    <select
                      value={termKey(row.term)}
                      onChange={e => {
                        const t = offer.terms.find(x => termKey(x) === e.target.value)
                        if (t) setRow(offer.lender_slug, { term: t })
                      }}
                      className="rounded-md border border-aurea-border bg-aurea-surface px-2 py-1 text-[11px] text-aurea-ink"
                    >
                      {offer.terms.map(t => (
                        <option key={termKey(t)} value={termKey(t)}>{termLabel(t)}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Totals */}
      <div className="mt-3 flex items-center justify-between border-t border-aurea-border pt-2">
        <div>
          <p className="text-[11px] text-aurea-ink-3">Total loan</p>
          <p className="font-mono text-[15px] tabular-nums font-medium text-aurea-ink">{money(totals.total_loan)}</p>
        </div>
        <div className="text-right">
          <p className="text-[11px] text-aurea-ink-3">Est. total monthly</p>
          <p className="aurea-display text-[20px] tabular-nums text-aurea-primary">{money(totals.total_monthly)}<span className="text-[12px] text-aurea-ink-3">/mo</span></p>
        </div>
      </div>

      {/* Acceleration coaching */}
      {accel.saved > 0 && (
        <div className="mt-2 rounded-lg border border-aurea-border bg-aurea-surface-2 px-3 py-2">
          <p className="aurea-eyebrow mb-0.5 text-aurea-ink-3">No prepayment penalty — pay it off faster</p>
          <p className="text-[12px] text-aurea-ink-2">
            Pay <span className="font-medium text-aurea-ink">$100/mo extra</span> (or switch to biweekly) and save about{' '}
            <span className="font-mono tabular-nums font-medium text-aurea-primary">{money(accel.saved)}</span> in interest
            {accel.monthsSaved > 0 && <> — done ~{accel.monthsSaved} months early</>}.
          </p>
        </div>
      )}

      {/* Proceed with the selected plan */}
      {onProceed && selections.length > 0 && (
        <button
          type="button"
          onClick={() => onProceed({ treatmentTotal, selections })}
          className="mt-3 w-full rounded-lg bg-aurea-primary px-3 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
        >
          {proceedLabel ?? 'Proceed with selected plan'}
        </button>
      )}

      {/* Other offers / declined */}
      {others.length > 0 && (
        <div className="mt-3">
          <p className="aurea-eyebrow mb-1.5 text-aurea-ink-3">Other offers you qualify for</p>
          <div className="space-y-1">
            {others.map(o => (
              <div key={o.lender_slug} className="flex items-center justify-between py-1">
                <span className={`text-[12px] ${o.decision === 'declined' ? 'text-aurea-ink-3 line-through' : 'font-medium text-aurea-ink'}`}>
                  {o.lender_name}
                </span>
                <span className="text-[11px] text-aurea-ink-3">
                  {o.decision === 'estimate'
                    ? (o.terms[0] ? `from ${termLabel(o.terms[0])} · apply to confirm` : 'apply to confirm')
                    : 'not approved'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
