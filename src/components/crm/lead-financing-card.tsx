'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { FinancingWaterfallTracker } from './financing-waterfall-tracker'
import { DollarSign, Send, RefreshCw, ExternalLink, Copy, Check } from 'lucide-react'
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

const STATUS_BADGE: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  approved: { label: 'Approved', variant: 'default' },
  denied: { label: 'Denied', variant: 'destructive' },
  in_progress: { label: 'In Progress', variant: 'secondary' },
  pending: { label: 'Pending', variant: 'outline' },
  expired: { label: 'Expired', variant: 'destructive' },
  error: { label: 'Error', variant: 'destructive' },
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

  const badgeConfig = appData ? STATUS_BADGE[appData.status] || STATUS_BADGE.pending : null

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <DollarSign className="h-4 w-4" /> Financing
          </span>
          {badgeConfig && (
            <Badge variant={badgeConfig.variant} className="text-xs">
              {badgeConfig.label}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {/* Basic financial info */}
        <div className="space-y-1.5">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Budget Range</span>
            <span className="font-medium capitalize">{lead.budget_range?.replace(/_/g, ' ') || '—'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Treatment Value</span>
            <span className="font-medium text-green-600">
              {lead.treatment_value ? `$${lead.treatment_value.toLocaleString()}` : '—'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Interest</span>
            <span className="font-medium capitalize">{lead.financing_interest?.replace(/_/g, ' ') || '—'}</span>
          </div>
        </div>

        {/* Approval info */}
        {appData?.status === 'approved' && appData.approved_amount && (
          <div className="rounded-lg border border-green-200 bg-green-50 p-3">
            <div className="flex justify-between items-center mb-1">
              <span className="text-xs font-semibold text-green-700 uppercase tracking-wide">Approved</span>
              <span className="text-lg font-bold text-green-700">${appData.approved_amount.toLocaleString()}</span>
            </div>
            {appData.approved_terms && (
              <div className="text-xs text-green-600 space-y-0.5">
                <p>${appData.approved_terms.monthly_payment}/mo &bull; {appData.approved_terms.apr}% APR &bull; {appData.approved_terms.term_months} months</p>
                {appData.approved_terms.promo_period_months && (
                  <p className="font-semibold">0% promo for {appData.approved_terms.promo_period_months} months</p>
                )}
              </div>
            )}
            {appData.approved_lender_slug && (
              <p className="text-xs text-green-600 mt-1">via {appData.approved_lender_slug}</p>
            )}
          </div>
        )}

        {/* Waterfall tracker */}
        {appData && appData.waterfall_config && (
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Waterfall Progress</p>
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
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Payment Estimates</p>
            <div className="space-y-1.5">
              {estimates.slice(0, 4).map((est, i) => (
                <div key={i} className="flex justify-between items-center text-xs rounded-md border px-2 py-1.5">
                  <span className="text-muted-foreground">{est.lender_name}</span>
                  <span className="font-semibold">
                    ${est.monthly_payment}/mo <span className="text-muted-foreground font-normal">{est.apr}% · {est.term_months}mo</span>
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
              <Send className="h-3.5 w-3.5 mr-1.5" />
              Send Financing Link
            </Button>
          )}

          {appData && (
            <Button variant="outline" size="sm" className="w-full" onClick={copyFinancingLink}>
              {copied ? <Check className="h-3.5 w-3.5 mr-1.5" /> : <Copy className="h-3.5 w-3.5 mr-1.5" />}
              {copied ? 'Copied!' : 'Copy Financing Link'}
            </Button>
          )}

          <Button variant="outline" size="sm" className="w-full" onClick={loadEstimates} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Loading...' : estimates.length > 0 ? 'Refresh Estimates' : 'Get Payment Estimates'}
          </Button>

          {appData && (
            <Button variant="ghost" size="sm" className="w-full text-xs" onClick={() => loadApplication(appData.id)}>
              <RefreshCw className="h-3 w-3 mr-1" /> Refresh Status
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
