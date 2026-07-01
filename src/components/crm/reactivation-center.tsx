'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import {
  RefreshCw, Plus, Play, Pause, Upload,
  Zap, Target, TrendingUp, Loader2,
  Gift, MessageSquare, ArrowRight, CheckCircle,
  Clock, Eye,
} from 'lucide-react'
import { toast } from 'sonner'
import { ReactivationBuilder } from './reactivation-builder'
import { ReactivationUpload } from './reactivation-upload'
import { ReactivationAnalytics } from './reactivation-analytics'
import { REACTIVATION_TEMPLATES } from '@/lib/campaigns/reactivation-templates'
import type { ReactivationCampaign } from '@/types/database'

// Editorial status — a dot + ink tone, never a candy badge. Emerald = live,
// amber = paused, gold = completed, ink-3 = draft.
const statusConfig: Record<string, { label: string; dot: string; ink: string; icon: typeof Play }> = {
  draft: { label: 'Draft', dot: 'bg-aurea-ink-3', ink: 'text-aurea-ink-3', icon: Clock },
  active: { label: 'Active', dot: 'bg-aurea-primary', ink: 'text-aurea-primary', icon: Play },
  paused: { label: 'Paused', dot: 'bg-aurea-amber', ink: 'text-aurea-amber', icon: Pause },
  completed: { label: 'Completed', dot: 'bg-aurea-gold', ink: 'text-aurea-gold', icon: CheckCircle },
}

const goalConfig: Record<string, { label: string }> = {
  re_engage: { label: 'Re-Engage' },
  win_back: { label: 'Win Back' },
  upsell: { label: 'Upsell' },
  referral_ask: { label: 'Referral' },
}

export function ReactivationCenter({ campaigns: initial }: { campaigns: ReactivationCampaign[] }) {
  const [campaigns, setCampaigns] = useState(initial)
  const [showBuilder, setShowBuilder] = useState(false)
  const [deployingTemplate, setDeployingTemplate] = useState<string | null>(null)
  const [togglingCampaign, setTogglingCampaign] = useState<string | null>(null)
  const [uploadingTo, setUploadingTo] = useState<string | null>(null)
  const [viewingAnalytics, setViewingAnalytics] = useState<string | null>(null)
  const router = useRouter()

  // Aggregate stats
  const totalUploaded = campaigns.reduce((s, c) => s + (c.total_uploaded || 0), 0)
  const totalReactivated = campaigns.reduce((s, c) => s + (c.total_reactivated || 0), 0)
  const totalResponded = campaigns.reduce((s, c) => s + (c.total_responded || 0), 0)
  const totalConverted = campaigns.reduce((s, c) => s + (c.total_converted || 0), 0)
  const activeCampaigns = campaigns.filter(c => c.status === 'active').length

  async function deployTemplate(templateId: string) {
    const template = REACTIVATION_TEMPLATES.find(t => t.id === templateId)
    if (!template) return

    setDeployingTemplate(templateId)
    try {
      const res = await fetch('/api/reactivation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: template.name,
          description: template.description,
          goal: template.goal,
          tone: template.tone,
          channel: template.channel,
          ai_hooks: template.hooks.map(h => ({ strategy: h, enabled: true, custom_text: null })),
          engagement_rules: template.engagement_rules,
          offers: template.default_offers,
          steps: template.steps,
        }),
      })

      if (!res.ok) throw new Error('Failed')
      toast.success(`"${template.name}" campaign created! Upload leads or activate it.`)
      router.refresh()
    } catch {
      toast.error('Failed to create campaign')
    } finally {
      setDeployingTemplate(null)
    }
  }

  async function toggleCampaign(id: string, currentStatus: string) {
    setTogglingCampaign(id)
    const action = currentStatus === 'active' ? 'pause' : 'activate'
    try {
      const res = await fetch(`/api/reactivation/${id}/${action}`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed')
      toast.success(action === 'activate' ? 'Campaign activated! AI engagement will begin.' : 'Campaign paused.')
      router.refresh()
    } catch {
      toast.error(`Failed to ${action} campaign`)
    } finally {
      setTogglingCampaign(null)
    }
  }

  // Show analytics for a specific campaign
  if (viewingAnalytics) {
    return (
      <ReactivationAnalytics
        campaignId={viewingAnalytics}
        onBack={() => setViewingAnalytics(null)}
      />
    )
  }

  // Show upload dialog
  if (uploadingTo) {
    return (
      <ReactivationUpload
        campaignId={uploadingTo}
        campaignName={campaigns.find(c => c.id === uploadingTo)?.name || 'Campaign'}
        onBack={() => { setUploadingTo(null); router.refresh() }}
      />
    )
  }

  // Show builder
  if (showBuilder) {
    return (
      <ReactivationBuilder
        onBack={() => { setShowBuilder(false); router.refresh() }}
      />
    )
  }

  const stats = [
    { index: '01', label: 'Leads Uploaded', value: totalUploaded, icon: Upload },
    { index: '02', label: 'Responded', value: totalResponded, icon: MessageSquare },
    { index: '03', label: 'Reactivated', value: totalReactivated, icon: Zap },
    { index: '04', label: 'Converted', value: totalConverted, icon: Target },
    { index: '05', label: 'Active Campaigns', value: activeCampaigns, icon: Play },
  ]

  return (
    <div className="animate-in fade-in-0 duration-500" id="reactivation-center">
      {/* ─── Header ─────────────────────────────────── */}
      <header className="flex flex-col gap-5 border-b border-aurea-border pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="aurea-eyebrow mb-3">Re-engagement</p>
          <h1 className="aurea-display text-[40px] text-aurea-ink sm:text-[52px]">
            Reactivation Center
          </h1>
          <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-aurea-ink-2">
            Upload your lead database and let AI re-engage dormant contacts with personalized
            hooks, promotions, and incentives.
          </p>
        </div>

        <Button onClick={() => setShowBuilder(true)} className="shrink-0 gap-2">
          <Plus className="h-4 w-4" strokeWidth={1.75} />
          New Campaign
        </Button>
      </header>

      {/* ─── KPI grid ───────────────────────────────── */}
      <div className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {stats.map((stat) => (
          <div key={stat.label} className="aurea-card p-5">
            <div className="flex items-center justify-between">
              <p className="aurea-eyebrow">{stat.label}</p>
              <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3">/{stat.index}</span>
            </div>
            <div className="mt-4 flex items-end justify-between">
              <p className="aurea-display text-[36px] tabular-nums text-aurea-ink">
                {stat.value.toLocaleString()}
              </p>
              <stat.icon className="mb-1.5 h-[18px] w-[18px] text-aurea-ink-3" strokeWidth={1.75} />
            </div>
          </div>
        ))}
      </div>

      {/* ─── Quick-Deploy Templates ───────────────── */}
      <section className="mt-10">
        <div className="mb-4">
          <p className="aurea-eyebrow mb-2">Templates</p>
          <p className="text-[13px] text-aurea-ink-3">Deploy a proven reactivation campaign in seconds</p>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {REACTIVATION_TEMPLATES.map((template) => {
            const goalConf = goalConfig[template.goal]
            return (
              <div
                key={template.id}
                id={`template-${template.id}`}
                className="aurea-card group flex flex-col p-5 transition-colors hover:border-aurea-border-strong"
              >
                {/* Header */}
                <div className="flex items-start justify-between">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-aurea-surface-2 text-aurea-ink-2 ring-1 ring-aurea-border">
                    <RefreshCw className="h-4 w-4" strokeWidth={1.75} />
                  </span>
                  <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wide text-aurea-ink-3">
                    <span>{goalConf?.label ?? template.goal}</span>
                    <span className="text-aurea-border-strong">·</span>
                    <span>{template.channel}</span>
                  </div>
                </div>

                {/* Content */}
                <h3 className="mt-4 text-[15px] font-medium text-aurea-ink">{template.name}</h3>
                <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-aurea-ink-3">
                  {template.description}
                </p>

                {/* Hooks Preview */}
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {template.hooks.slice(0, 3).map((hook) => (
                    <span
                      key={hook}
                      className="rounded-md bg-aurea-surface-2 px-2 py-0.5 text-[11px] capitalize text-aurea-ink-2 ring-1 ring-aurea-border"
                    >
                      {hook.replace(/_/g, ' ')}
                    </span>
                  ))}
                </div>

                {/* Offers Preview */}
                {template.default_offers.length > 0 && (
                  <div className="mt-3 flex items-center gap-1.5 text-[12px] text-aurea-ink-3">
                    <Gift className="h-3.5 w-3.5 text-aurea-gold" strokeWidth={1.75} />
                    <span className="truncate">{template.default_offers.map((o) => o.name).join(', ')}</span>
                  </div>
                )}

                {/* Footer: steps + deploy */}
                <div className="mt-5 flex items-center justify-between gap-3">
                  <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3">
                    {template.steps.length} steps
                  </span>
                  <Button
                    size="sm"
                    className="gap-1.5"
                    onClick={() => deployTemplate(template.id)}
                    disabled={deployingTemplate === template.id}
                  >
                    {deployingTemplate === template.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Zap className="h-4 w-4" strokeWidth={1.75} />
                    )}
                    Deploy
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {/* ─── Active Campaigns ─────────────────────── */}
      <section className="mt-10">
        <div className="mb-4">
          <p className="aurea-eyebrow mb-2">Your Campaigns</p>
          <p className="text-[13px] text-aurea-ink-3">Manage campaigns and upload lead databases</p>
        </div>

        {campaigns.length === 0 ? (
          <div className="aurea-card flex flex-col items-center px-6 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-aurea-surface-2 text-aurea-ink-3 ring-1 ring-aurea-border">
              <RefreshCw className="h-5 w-5" strokeWidth={1.75} />
            </span>
            <p className="mt-4 text-[15px] font-medium text-aurea-ink">No reactivation campaigns yet</p>
            <p className="mt-1.5 max-w-md text-[13px] leading-relaxed text-aurea-ink-3">
              Deploy a template above or build a custom campaign from scratch. Upload your lead
              spreadsheet to get started.
            </p>
            <Button onClick={() => setShowBuilder(true)} className="mt-6 gap-2">
              <Plus className="h-4 w-4" strokeWidth={1.75} />
              Create Your First Campaign
            </Button>
          </div>
        ) : (
          <div className="aurea-card overflow-hidden">
            {campaigns.map((campaign) => {
              const sc = statusConfig[campaign.status] || statusConfig.draft
              const gc = goalConfig[campaign.goal] || goalConfig.re_engage

              return (
                <div
                  key={campaign.id}
                  id={`campaign-${campaign.id}`}
                  className="flex flex-col gap-4 border-b border-aurea-border px-5 py-4 last:border-0 lg:flex-row lg:items-center"
                >
                  {/* Left: Info */}
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-aurea-surface-2 text-aurea-ink-2 ring-1 ring-aurea-border">
                      <RefreshCw className="h-[18px] w-[18px]" strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <p className="truncate text-[14px] font-medium text-aurea-ink">{campaign.name}</p>
                        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium">
                          <span className={`h-1.5 w-1.5 rounded-full ${sc.dot}`} />
                          <span className={sc.ink}>{sc.label}</span>
                        </span>
                        <span className="font-mono text-[10px] uppercase tracking-wide text-aurea-ink-3">{gc.label}</span>
                        {campaign.offers && campaign.offers.length > 0 && (
                          <span className="inline-flex items-center gap-1 text-[11px] text-aurea-ink-3">
                            <Gift className="h-3 w-3 text-aurea-gold" strokeWidth={1.75} />
                            {campaign.offers.length} offer{campaign.offers.length > 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                      {campaign.description && (
                        <p className="mt-0.5 truncate text-[12px] text-aurea-ink-3">{campaign.description}</p>
                      )}
                    </div>
                  </div>

                  {/* Center: Stat flow */}
                  <div className="flex items-center gap-4 text-center sm:gap-5">
                    {[
                      { v: campaign.total_uploaded || 0, l: 'Uploaded', accent: false },
                      { v: campaign.total_responded || 0, l: 'Responded', accent: false },
                      { v: campaign.total_reactivated || 0, l: 'Reactivated', accent: false },
                      { v: campaign.total_converted || 0, l: 'Converted', accent: true },
                    ].map((s, i, arr) => (
                      <div key={s.l} className="flex items-center gap-4 sm:gap-5">
                        <div>
                          <p className={`aurea-display text-[20px] tabular-nums ${s.accent ? 'text-aurea-primary' : 'text-aurea-ink'}`}>
                            {s.v}
                          </p>
                          <p className="aurea-eyebrow mt-0.5 !tracking-[0.1em]">{s.l}</p>
                        </div>
                        {i < arr.length - 1 && (
                          <ArrowRight className="h-3 w-3 text-aurea-ink-3" strokeWidth={1.75} />
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Right: Actions */}
                  <div className="flex shrink-0 items-center gap-2">
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setUploadingTo(campaign.id)}>
                      <Upload className="h-3.5 w-3.5" strokeWidth={1.75} />
                      Upload
                    </Button>

                    <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => setViewingAnalytics(campaign.id)}>
                      <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />
                      View
                    </Button>

                    {campaign.status === 'draft' || campaign.status === 'paused' ? (
                      <Button
                        size="sm"
                        className="gap-1.5"
                        onClick={() => toggleCampaign(campaign.id, campaign.status)}
                        disabled={togglingCampaign === campaign.id}
                      >
                        {togglingCampaign === campaign.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Play className="h-3.5 w-3.5" strokeWidth={1.75} />
                        )}
                        Activate
                      </Button>
                    ) : campaign.status === 'active' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        onClick={() => toggleCampaign(campaign.id, campaign.status)}
                        disabled={togglingCampaign === campaign.id}
                      >
                        {togglingCampaign === campaign.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Pause className="h-3.5 w-3.5" strokeWidth={1.75} />
                        )}
                        Pause
                      </Button>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ─── How It Works ─────────────────────────── */}
      <section className="mt-10">
        <p className="aurea-eyebrow mb-4 flex items-center gap-2">
          <TrendingUp className="h-3.5 w-3.5 text-aurea-ink-3" strokeWidth={1.75} />
          How Reactivation Works
        </p>
        <div className="aurea-card grid grid-cols-1 gap-y-6 p-6 sm:grid-cols-2 lg:grid-cols-4 lg:gap-x-8">
          {[
            { step: '01', title: 'Upload Database', desc: 'Import your CSV / spreadsheet of dormant leads', icon: Upload },
            { step: '02', title: 'AI Engages', desc: 'AI sends personalized hooks & offers via SMS / Email', icon: Zap },
            { step: '03', title: 'Leads Respond', desc: 'Interested leads reply and re-enter your pipeline', icon: MessageSquare },
            { step: '04', title: 'Convert', desc: 'Live AI or your team closes the reactivated leads', icon: Target },
          ].map((item) => (
            <div key={item.step} className="flex items-start gap-3.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-aurea-surface-2 text-aurea-ink-2 ring-1 ring-aurea-border">
                <item.icon className="h-4 w-4" strokeWidth={1.75} />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3">/{item.step}</span>
                  <p className="text-[13.5px] font-medium text-aurea-ink">{item.title}</p>
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-aurea-ink-3">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
