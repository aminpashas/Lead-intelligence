'use client'

import { useEffect, useState } from 'react'
import { Bot, User, Loader2, Scale } from 'lucide-react'
import { formatDuration, formatMoney, formatPercent } from '@/lib/automation/matrix'

/**
 * AI-vs-Human scoreboard — side-by-side lane metrics from the
 * automation_scoreboard / automation_outcomes RPCs.
 *
 * Honest labeling: attribution is TOUCH-BASED (which sender types messaged a
 * lead inside the window), not causal lift — the caption says so.
 *
 * Per-campaign drill-down is deliberately skipped in v1 (it would need a
 * campaign column threaded through both RPCs); the window selector covers the
 * first-order question.
 */

type LaneRow = {
  lane: 'ai' | 'human'
  median_response_seconds: number | null
  p90_response_seconds: number | null
  responses: number
  sla_met_rate: number | null
  takeover_count: number
  outbound_messages: number
  replied_messages: number
  reply_rate: number | null
  tasks_completed: number
  tasks_total: number
  avg_claim_seconds: number | null
  escalation_count: number
}

type OutcomeRow = {
  lane: 'ai' | 'human' | 'mixed'
  leads_touched: number
  conversions: number
  conversion_rate: number | null
  revenue_total: number | null
  revenue_per_lead: number | null
}

type ScoreboardData = {
  available: boolean
  error?: string
  lanes?: LaneRow[]
  outcomes?: OutcomeRow[]
}

const WINDOWS = [7, 30, 90] as const

export function AutomationScoreboard() {
  const [days, setDays] = useState<number>(30)
  // The fetched payload is stamped with the window it answers; "loading" is
  // derived (result window ≠ selected window) so the effect never sets state
  // synchronously on window change.
  const [result, setResult] = useState<
    { days: number; data: ScoreboardData | null; failed: boolean } | null
  >(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/automation/scoreboard?days=${days}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((json) => {
        if (!cancelled) setResult({ days, data: json, failed: false })
      })
      .catch(() => {
        if (!cancelled) setResult({ days, data: null, failed: true })
      })
    return () => {
      cancelled = true
    }
  }, [days])

  const loading = result == null || result.days !== days
  const failed = !loading && result.failed
  const data = loading ? null : result.data

  const ai = data?.lanes?.find((l) => l.lane === 'ai')
  const human = data?.lanes?.find((l) => l.lane === 'human')

  return (
    <section className="aurea-card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Scale className="h-4 w-4 text-aurea-primary" strokeWidth={1.75} />
          <h2 className="text-[15px] font-semibold text-aurea-ink">AI vs Human scoreboard</h2>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-aurea-ink-3">
            Touch-based attribution, not causal lift.
          </span>
          <div className="inline-flex overflow-hidden rounded-lg border border-aurea-border">
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setDays(w)}
                className={`px-2.5 py-1 text-[12px] font-medium transition-colors ${
                  days === w
                    ? 'bg-aurea-ink text-aurea-canvas'
                    : 'text-aurea-ink-3 hover:bg-aurea-surface-2 hover:text-aurea-ink'
                }`}
              >
                {w}d
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-aurea-ink-3">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading scoreboard…
        </div>
      ) : failed ? (
        <p className="py-8 text-center text-[13px] text-aurea-rose">
          Failed to load the scoreboard — try again in a moment.
        </p>
      ) : data && !data.available ? (
        <p className="py-8 text-center text-[13px] text-aurea-ink-3">
          Scoreboard metrics are not deployed to this environment yet (pending database
          migration). Everything else on this page works.
        </p>
      ) : (
        <>
          <div className="grid gap-6 md:grid-cols-2">
            <LaneColumn
              title="AI"
              icon={<Bot className="h-4 w-4 text-aurea-primary" strokeWidth={1.75} />}
              rows={[
                ['Median first response', formatDuration(ai?.median_response_seconds)],
                ['P90 first response', formatDuration(ai?.p90_response_seconds)],
                ['SLA met', formatPercent(ai?.sla_met_rate)],
                ['Messages sent', String(ai?.outbound_messages ?? 0)],
                ['Reply rate (24h)', formatPercent(ai?.reply_rate)],
                ['Takeovers after human window', String(ai?.takeover_count ?? 0)],
                ['Escalations to humans', String(ai?.escalation_count ?? 0)],
              ]}
            />
            <LaneColumn
              title="Human"
              icon={<User className="h-4 w-4 text-aurea-amber" strokeWidth={1.75} />}
              rows={[
                ['Median first response', formatDuration(human?.median_response_seconds)],
                ['P90 first response', formatDuration(human?.p90_response_seconds)],
                ['SLA met', formatPercent(human?.sla_met_rate)],
                ['Messages sent', String(human?.outbound_messages ?? 0)],
                ['Reply rate (24h)', formatPercent(human?.reply_rate)],
                [
                  'Tasks completed',
                  `${human?.tasks_completed ?? 0} of ${human?.tasks_total ?? 0}`,
                ],
                ['Avg task claim time', formatDuration(human?.avg_claim_seconds)],
              ]}
            />
          </div>

          {(data?.outcomes?.length ?? 0) > 0 && (
            <div className="mt-6 overflow-x-auto border-t border-aurea-border pt-4">
              <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-aurea-ink-3">
                Outcomes by lane (leads touched in window)
              </div>
              <table className="w-full text-left text-[12.5px]">
                <thead>
                  <tr className="border-b border-aurea-border text-[10.5px] uppercase tracking-[0.08em] text-aurea-ink-3">
                    <th className="py-2 pr-3 font-semibold">Lane</th>
                    <th className="py-2 pr-3 font-semibold">Leads touched</th>
                    <th className="py-2 pr-3 font-semibold">Conversions</th>
                    <th className="py-2 pr-3 font-semibold">Conv. rate</th>
                    <th className="py-2 pr-3 font-semibold">Revenue</th>
                    <th className="py-2 font-semibold">Revenue / lead</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-aurea-border/60">
                  {(['ai', 'human', 'mixed'] as const).map((lane) => {
                    const row = data?.outcomes?.find((o) => o.lane === lane)
                    if (!row) return null
                    return (
                      <tr key={lane}>
                        <td className="py-2 pr-3 font-medium capitalize text-aurea-ink">
                          {lane === 'mixed' ? 'Mixed (AI + human)' : lane === 'ai' ? 'AI only' : 'Human only'}
                        </td>
                        <td className="py-2 pr-3 tabular-nums text-aurea-ink-2">
                          {row.leads_touched}
                        </td>
                        <td className="py-2 pr-3 tabular-nums text-aurea-ink-2">
                          {row.conversions}
                        </td>
                        <td className="py-2 pr-3 tabular-nums text-aurea-ink-2">
                          {formatPercent(row.conversion_rate)}
                        </td>
                        <td className="py-2 pr-3 tabular-nums text-aurea-ink-2">
                          {formatMoney(row.revenue_total)}
                        </td>
                        <td className="py-2 tabular-nums text-aurea-ink-2">
                          {formatMoney(row.revenue_per_lead)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="mt-2 text-[11px] leading-relaxed text-aurea-ink-3">
                A lead counts toward a lane by who messaged it inside the window — leads both
                sides touched are &ldquo;Mixed&rdquo;. This describes correlation, not what caused the
                conversion.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function LaneColumn({
  title,
  icon,
  rows,
}: {
  title: string
  icon: React.ReactNode
  rows: Array<[string, string]>
}) {
  return (
    <div className="rounded-lg border border-aurea-border bg-aurea-canvas p-4">
      <div className="mb-3 flex items-center gap-2">
        {icon}
        <span className="text-[13px] font-semibold text-aurea-ink">{title}</span>
      </div>
      <dl className="divide-y divide-aurea-border/60">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-3 py-[7px]">
            <dt className="text-[12px] text-aurea-ink-3">{label}</dt>
            <dd className="aurea-display text-[15px] tabular-nums text-aurea-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
