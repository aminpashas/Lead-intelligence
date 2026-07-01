'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { FinancingWaterfallTracker } from './financing-waterfall-tracker'
import { DollarSign, Send, RefreshCw, Copy, Check } from 'lucide-react'
import type { Lead } from '@/types/database'

type FinancingAppData = {
  id: string
  status: string
  requested_amount: number | null
  approved_lender_slug: string | null
  approved_amount: number | null
  approved_terms: { apr: number; term_months: number; monthly_payment: number; promo_period_months?: number } | null
  current_waterfall_step: number
  waterfall_config: { lenders: Array<{ slug: string; priority: number; integration_type: string }> }
  expires_at: string
  completed_at: string | null
  created_at: string
  submissions: Array<{
    lender_slug: string
    waterfall_step: number
    status: string
    application_url: string | null
    responded_at: string | null
  }>
}

type EstimateData = {
  lender_slug: string
  lender_name: string
  monthly_payment: number
  apr: number
  term_months: number
}

// Application status pill styles — emerald=approved, amber=in_progress/pending, rose=denied/error/expired
const STATUS_PILL: Record<string, string> = {
  approved:    'bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20',
  denied:      'bg-aurea-rose/10 text-aurea-rose border border-aurea-rose/20',
  in_progress: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20',
  pending:     'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border',
  expired:     'bg-aurea-rose/10 text-aurea-rose border border-aurea-rose/20',
  error:       'bg-aurea-rose/10 text-aurea-rose border border-aurea-rose/20',
}

const STATUS_LABEL: Record<string, string> = {
  approved: 'Approved', denied: 'Denied', in_progress: 'In Progress',
  pending: 'Pending', expired: 'Expired', error: 'Error',
}

// Financial-readiness tier surfaced from the AI qualifier. Only shown once the
// lead has actually been assessed (see `assessed` below) — otherwise the column
// default `tier_c` would read as a real grade on leads that were never scored
// (e.g. bulk-imported GHL contacts with no conversation yet).
const TIER_PILL: Record<string, { label: string; className: string }> = {
  tier_a: { label: 'Tier A · Ready',    className: 'bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20' },
  tier_b: { label: 'Tier B · Warming',  className: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20' },
  tier_c: { label: 'Tier C · Early',    className: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border' },
  tier_d: { label: 'Tier D · Barriers', className: 'bg-aurea-rose/10 text-aurea-rose border border-aurea-rose/20' },
}

export function LeadFinancingCard({ lead }: { lead: Lead }) {
  const [appData, setAppData] = useState<FinancingAppData | null>(null)
  const [estimates, setEstimates] = useState<EstimateData[]>([])
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [estimateAmount, setEstimateAmount] = useState(lead.treatment_value?.toString() || '20000')

  // Load existing financing application if one exists
  useEffect(() => {
    if (lead.financing_application_id) {
      loadApplication(lead.financing_application_id)
    }
  }, [lead.financing_application_id])

  async function loadApplication(appId: string) {
    try {
      const res = await fetch(`/api/financing/${appId}`)
      if (res.ok) {
        const data = await res.json()
        setAppData(data)
      }
    } catch { /* silent */ }
  }

  async function loadEstimates() {
    setLoading(true)
    try {
      const res = await fetch('/api/financing/estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: Number(estimateAmount) || 20000 }),
      })
      if (res.ok) {
        const data = await res.json()
        setEstimates(data.estimates || [])
      }
    } catch { /* silent */ }
    finally { setLoading(false) }
  }

  function copyFinancingLink() {
    if (!appData?.id) return
    // In production, this would be the share token URL
    const url = `${window.location.origin}/finance/${appData.id}`
    navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const statusPillClass = appData ? (STATUS_PILL[appData.status] ?? STATUS_PILL.pending) : null
  const statusLabel = appData ? (STATUS_LABEL[appData.status] ?? 'Pending') : null

  // A lead is only "assessed" once the text-derived qualifier has run (it sets
  // financial_qualification_status='assessed' and stamps financial_signals).
  // Never-assessed leads (e.g. bulk-imported GHL contacts) must NOT show a tier —
  // we render "Not assessed" instead of a fabricated grade.
  const assessed =
    lead.financial_qualification_status === 'assessed' || !!lead.financial_signals?.last_updated
  const tierConfig =
    (lead.financial_qualification_tier && TIER_PILL[lead.financial_qualification_tier]) ||
    TIER_PILL.tier_c

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-[14px]">
          <span className="flex items-center gap-2 text-aurea-ink">
            <DollarSign className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
            Financing
          </span>
          {statusPillClass && (
            <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ${statusPillClass}`}>
              {statusLabel}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Basic financial info */}
        <div className="space-y-0">
          <div className="flex items-center justify-between border-b border-aurea-border py-2 last:border-0">
            <span className="text-[12px] text-aurea-ink-3">Budget Range</span>
            <span className="text-[12px] font-medium capitalize text-aurea-ink">
              {lead.budget_range?.replace(/_/g, ' ') || '—'}
            </span>
          </div>
          <div className="flex items-center justify-between border-b border-aurea-border py-2 last:border-0">
            <span className="text-[12px] text-aurea-ink-3">Treatment Value</span>
            <span className="font-mono text-[12px] tabular-nums font-medium text-aurea-primary">
              {lead.treatment_value ? `$${lead.treatment_value.toLocaleString()}` : '—'}
            </span>
          </div>
          <div className="flex items-center justify-between border-b border-aurea-border py-2 last:border-0">
            <span className="text-[12px] text-aurea-ink-3">Interest</span>
            <span className="text-[12px] font-medium capitalize text-aurea-ink">
              {lead.financing_interest?.replace(/_/g, ' ') || '—'}
            </span>
          </div>
          <div className="flex items-center justify-between py-2">
            <span className="text-[12px] text-aurea-ink-3">Financing Signal</span>
            {assessed ? (
              <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ${tierConfig.className}`}>
                {tierConfig.label} &middot; {lead.financing_readiness_score}/100
              </span>
            ) : (
              <span className="inline-flex items-center rounded-md border border-aurea-border bg-aurea-surface-2 px-2 py-0.5 text-[11px] text-aurea-ink-3">
                Not assessed
              </span>
            )}
          </div>
        </div>

        {!assessed && (
          <p className="text-[11px] leading-tight text-aurea-ink-3">
            No financial signals yet — readiness is inferred from conversation, not a credit check.
          </p>
        )}

        {/* Approval info */}
        {appData?.status === 'approved' && appData.approved_amount && (
          <div className="rounded-lg border border-aurea-primary/20 bg-aurea-primary/5 p-3">
            <div className="mb-1.5 flex items-center justify-between">
              <p className="aurea-eyebrow text-aurea-primary">Approved</p>
              <p className="aurea-display text-[22px] tabular-nums text-aurea-primary">
                ${appData.approved_amount.toLocaleString()}
              </p>
            </div>
            {appData.approved_terms && (
              <div className="space-y-0.5 font-mono text-[11px] tabular-nums text-aurea-ink-2">
                <p>${appData.approved_terms.monthly_payment}/mo &bull; {appData.approved_terms.apr}% APR &bull; {appData.approved_terms.term_months} months</p>
                {appData.approved_terms.promo_period_months && (
                  <p className="font-semibold text-aurea-primary">0% promo for {appData.approved_terms.promo_period_months} months</p>
                )}
              </div>
            )}
            {appData.approved_lender_slug && (
              <p className="mt-1 text-[11px] text-aurea-ink-3">via {appData.approved_lender_slug}</p>
            )}
          </div>
        )}

        {/* Waterfall tracker */}
        {appData && appData.waterfall_config && (
          <div>
            <p className="aurea-eyebrow mb-2 text-aurea-ink-3">Waterfall Progress</p>
            <FinancingWaterfallTracker
              waterfallConfig={appData.waterfall_config as any}
              submissions={appData.submissions as any}
              currentStep={appData.current_waterfall_step}
            />
          </div>
        )}

        {/* Payment estimates */}
        {estimates.length > 0 && (
          <div>
            <p className="aurea-eyebrow mb-2 text-aurea-ink-3">Payment Estimates</p>
            <div className="space-y-1.5">
              {estimates.slice(0, 4).map((est, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-lg border border-aurea-border bg-aurea-surface px-3 py-2"
                >
                  <span className="text-[12px] text-aurea-ink-3">{est.lender_name}</span>
                  <span className="font-mono text-[12px] tabular-nums font-medium text-aurea-ink">
                    ${est.monthly_payment}/mo{' '}
                    <span className="font-normal text-aurea-ink-3">{est.apr}% · {est.term_months}mo</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col gap-2 pt-1">
          {!appData && (
            <Button variant="default" size="sm" className="w-full" onClick={() => {
              // In production: open a dialog to start financing application
              window.open(`/qualify/${lead.organization_id}?lead_id=${lead.id}`, '_blank')
            }}>
              <Send className="h-3.5 w-3.5 mr-1.5" strokeWidth={1.75} />
              Send Financing Link
            </Button>
          )}

          {appData && (
            <Button variant="outline" size="sm" className="w-full" onClick={copyFinancingLink}>
              {copied
                ? <Check className="h-3.5 w-3.5 mr-1.5" strokeWidth={1.75} />
                : <Copy className="h-3.5 w-3.5 mr-1.5" strokeWidth={1.75} />}
              {copied ? 'Copied!' : 'Copy Financing Link'}
            </Button>
          )}

          <Button variant="outline" size="sm" className="w-full" onClick={loadEstimates} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.75} />
            {loading ? 'Loading…' : estimates.length > 0 ? 'Refresh Estimates' : 'Get Payment Estimates'}
          </Button>

          {appData && (
            <Button variant="ghost" size="sm" className="w-full text-[12px] text-aurea-ink-3" onClick={() => loadApplication(appData.id)}>
              <RefreshCw className="h-3 w-3 mr-1" strokeWidth={1.75} /> Refresh Status
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
