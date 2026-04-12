'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  RefreshCw, Plus, Play, Pause, Upload, BarChart3,
  Users, Zap, Target, TrendingUp, Loader2, Sparkles,
  Gift, Mail, MessageSquare, ArrowRight, CheckCircle,
  Clock, Eye,
} from 'lucide-react'
import { toast } from 'sonner'
import { ReactivationBuilder } from './reactivation-builder'
import { ReactivationUpload } from './reactivation-upload'
import { ReactivationAnalytics } from './reactivation-analytics'
import { REACTIVATION_TEMPLATES } from '@/lib/campaigns/reactivation-templates'
import type { ReactivationCampaign } from '@/types/database'

const statusConfig: Record<string, { color: string; icon: typeof Play }> = {
  draft: { color: 'bg-gray-100 text-gray-700 border-gray-200', icon: Clock },
  active: { color: 'bg-emerald-100 text-emerald-700 border-emerald-200', icon: Play },
  paused: { color: 'bg-amber-100 text-amber-700 border-amber-200', icon: Pause },
  completed: { color: 'bg-blue-100 text-blue-700 border-blue-200', icon: CheckCircle },
}

const goalConfig: Record<string, { label: string; gradient: string }> = {
  re_engage: { label: 'Re-Engage', gradient: 'from-blue-500 to-cyan-500' },
  win_back: { label: 'Win Back', gradient: 'from-purple-500 to-pink-500' },
  upsell: { label: 'Upsell', gradient: 'from-amber-500 to-orange-500' },
  referral_ask: { label: 'Referral', gradient: 'from-emerald-500 to-teal-500' },
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

  return (
    <div className="space-y-6" id="reactivation-center">
      {/* ─── Hero Banner ─────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-violet-600 via-purple-600 to-indigo-700 p-6 lg:p-8 text-white">
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiNmZmYiIGZpbGwtb3BhY2l0eT0iMC4wNSI+PHBhdGggZD0iTTM2IDE4YzAtOS45NC04LjA2LTE4LTE4LTE4cy0xOCA4LjA2LTE4IDE4IDguMDYgMTggMTggMTggMTgtOC4wNiAxOC0xOHoiLz48L2c+PC9nPjwvc3ZnPg==')] opacity-30" />

        <div className="relative flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-white/20 backdrop-blur-sm">
                <RefreshCw className="h-5 w-5" />
              </div>
              <h1 className="text-2xl lg:text-3xl font-bold">Reactivation Center</h1>
            </div>
            <p className="text-white/80 max-w-xl">
              Upload your lead database and let AI re-engage dormant contacts with personalized hooks, promos, and incentives.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Button
              onClick={() => setShowBuilder(true)}
              className="bg-white text-purple-700 hover:bg-white/90 gap-2 shadow-lg"
            >
              <Plus className="h-4 w-4" />
              New Campaign
            </Button>
          </div>
        </div>

        {/* Quick Stats */}
        <div className="relative grid grid-cols-2 lg:grid-cols-5 gap-4 mt-6">
          {[
            { label: 'Leads Uploaded', value: totalUploaded, icon: Upload },
            { label: 'Responded', value: totalResponded, icon: MessageSquare },
            { label: 'Reactivated', value: totalReactivated, icon: Zap },
            { label: 'Converted', value: totalConverted, icon: Target },
            { label: 'Active Campaigns', value: activeCampaigns, icon: Play },
          ].map((stat) => (
            <div key={stat.label} className="rounded-xl bg-white/10 backdrop-blur-sm p-4 border border-white/10">
              <div className="flex items-center gap-2 mb-1">
                <stat.icon className="h-4 w-4 text-white/60" />
                <span className="text-xs text-white/60 font-medium">{stat.label}</span>
              </div>
              <p className="text-2xl font-bold">{stat.value.toLocaleString()}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ─── Quick-Deploy Templates ───────────────── */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-amber-500" />
              One-Click Templates
            </h2>
            <p className="text-sm text-muted-foreground">Deploy a proven reactivation campaign in seconds</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {REACTIVATION_TEMPLATES.map((template) => {
            const goalConf = goalConfig[template.goal]
            return (
              <Card key={template.id} className="group hover:border-purple-300 hover:shadow-md transition-all duration-200" id={`template-${template.id}`}>
                <CardContent className="pt-5">
                  {/* Header */}
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div className={`h-8 w-8 rounded-lg bg-gradient-to-br ${goalConf.gradient} flex items-center justify-center`}>
                        <RefreshCw className="h-4 w-4 text-white" />
                      </div>
                      <Badge variant="secondary" className="text-xs">{template.steps.length} steps</Badge>
                    </div>
                    <div className="flex gap-1.5">
                      <Badge variant="outline" className="text-xs">{goalConf.label}</Badge>
                      <Badge variant="outline" className="text-xs">{template.channel}</Badge>
                    </div>
                  </div>

                  {/* Content */}
                  <h3 className="font-semibold mb-1">{template.name}</h3>
                  <p className="text-sm text-muted-foreground mb-3 line-clamp-2">{template.description}</p>

                  {/* Hooks Preview */}
                  <div className="flex flex-wrap gap-1 mb-4">
                    {template.hooks.slice(0, 3).map((hook) => (
                      <span key={hook} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-600 border border-purple-100">
                        {hook === 'urgency' && '🔥'}
                        {hook === 'social_proof' && '👥'}
                        {hook === 'new_technology' && '🆕'}
                        {hook === 'special_pricing' && '💰'}
                        {hook === 'empathy' && '💛'}
                        {hook === 'personalized_value' && '🎯'}
                        {hook.replace(/_/g, ' ')}
                      </span>
                    ))}
                  </div>

                  {/* Offers Preview */}
                  {template.default_offers.length > 0 && (
                    <div className="flex items-center gap-1.5 mb-4 text-xs text-muted-foreground">
                      <Gift className="h-3.5 w-3.5 text-pink-500" />
                      {template.default_offers.map(o => o.name).join(', ')}
                    </div>
                  )}

                  {/* Deploy Button */}
                  <Button
                    size="sm"
                    className="w-full gap-1.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700"
                    onClick={() => deployTemplate(template.id)}
                    disabled={deployingTemplate === template.id}
                  >
                    {deployingTemplate === template.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Zap className="h-4 w-4" />
                    )}
                    Deploy Template
                  </Button>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </div>

      {/* ─── Active Campaigns ─────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold">Your Reactivation Campaigns</h2>
            <p className="text-sm text-muted-foreground">Manage campaigns and upload lead databases</p>
          </div>
        </div>

        {campaigns.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center py-16">
              <div className="h-16 w-16 rounded-2xl bg-purple-50 flex items-center justify-center mb-4">
                <RefreshCw className="h-8 w-8 text-purple-400" />
              </div>
              <p className="font-semibold text-lg mb-1">No reactivation campaigns yet</p>
              <p className="text-sm text-muted-foreground mb-6 text-center max-w-md">
                Deploy a template above or create a custom campaign from scratch. Upload your lead spreadsheet to get started.
              </p>
              <Button onClick={() => setShowBuilder(true)} className="gap-2">
                <Plus className="h-4 w-4" />
                Create Your First Campaign
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {campaigns.map((campaign) => {
              const sc = statusConfig[campaign.status] || statusConfig.draft
              const gc = goalConfig[campaign.goal] || goalConfig.re_engage
              const StatusIcon = sc.icon

              return (
                <Card key={campaign.id} className="hover:shadow-sm transition-shadow" id={`campaign-${campaign.id}`}>
                  <CardContent className="py-4">
                    <div className="flex flex-col lg:flex-row lg:items-center gap-4">
                      {/* Left: Info */}
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <div className={`h-10 w-10 rounded-lg bg-gradient-to-br ${gc.gradient} flex items-center justify-center shrink-0`}>
                          <RefreshCw className="h-5 w-5 text-white" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-semibold truncate">{campaign.name}</p>
                            <Badge className={`${sc.color} text-xs gap-1`}>
                              <StatusIcon className="h-3 w-3" />
                              {campaign.status}
                            </Badge>
                            <Badge variant="outline" className="text-xs">{gc.label}</Badge>
                          </div>
                          {campaign.description && (
                            <p className="text-sm text-muted-foreground mt-0.5 truncate">{campaign.description}</p>
                          )}
                        </div>
                      </div>

                      {/* Center: Stats */}
                      <div className="flex items-center gap-6 text-sm">
                        <div className="text-center">
                          <p className="font-semibold text-lg">{campaign.total_uploaded || 0}</p>
                          <p className="text-xs text-muted-foreground">Uploaded</p>
                        </div>
                        <ArrowRight className="h-3 w-3 text-muted-foreground" />
                        <div className="text-center">
                          <p className="font-semibold text-lg">{campaign.total_responded || 0}</p>
                          <p className="text-xs text-muted-foreground">Responded</p>
                        </div>
                        <ArrowRight className="h-3 w-3 text-muted-foreground" />
                        <div className="text-center">
                          <p className="font-semibold text-lg">{campaign.total_reactivated || 0}</p>
                          <p className="text-xs text-muted-foreground">Reactivated</p>
                        </div>
                        <ArrowRight className="h-3 w-3 text-muted-foreground" />
                        <div className="text-center">
                          <p className="font-semibold text-lg text-emerald-600">{campaign.total_converted || 0}</p>
                          <p className="text-xs text-muted-foreground">Converted</p>
                        </div>
                      </div>

                      {/* Right: Actions */}
                      <div className="flex items-center gap-2 shrink-0">
                        {/* Offers badge */}
                        {campaign.offers && campaign.offers.length > 0 && (
                          <Badge variant="outline" className="text-xs gap-1 text-pink-600 border-pink-200">
                            <Gift className="h-3 w-3" />
                            {campaign.offers.length} offer{campaign.offers.length > 1 ? 's' : ''}
                          </Badge>
                        )}

                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5"
                          onClick={() => setUploadingTo(campaign.id)}
                        >
                          <Upload className="h-3.5 w-3.5" />
                          Upload
                        </Button>

                        <Button
                          size="sm"
                          variant="ghost"
                          className="gap-1.5"
                          onClick={() => setViewingAnalytics(campaign.id)}
                        >
                          <Eye className="h-3.5 w-3.5" />
                          View
                        </Button>

                        {campaign.status === 'draft' || campaign.status === 'paused' ? (
                          <Button
                            size="sm"
                            className="gap-1.5 bg-emerald-600 hover:bg-emerald-700"
                            onClick={() => toggleCampaign(campaign.id, campaign.status)}
                            disabled={togglingCampaign === campaign.id}
                          >
                            {togglingCampaign === campaign.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Play className="h-3.5 w-3.5" />
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
                              <Pause className="h-3.5 w-3.5" />
                            )}
                            Pause
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      {/* ─── How It Works ─────────────────────────── */}
      <Card className="bg-gradient-to-br from-slate-50 to-slate-100/50 border-slate-200">
        <CardContent className="py-6">
          <h3 className="font-semibold mb-4 flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-purple-600" />
            How Reactivation Works
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {[
              { step: '1', title: 'Upload Database', desc: 'Import your CSV/spreadsheet of dormant leads', icon: Upload, color: 'bg-blue-100 text-blue-600' },
              { step: '2', title: 'AI Engages', desc: 'AI sends personalized hooks & offers via SMS/Email', icon: Sparkles, color: 'bg-purple-100 text-purple-600' },
              { step: '3', title: 'Leads Respond', desc: 'Interested leads reply and re-enter your pipeline', icon: MessageSquare, color: 'bg-amber-100 text-amber-600' },
              { step: '4', title: 'Convert', desc: 'Live AI or your team closes the reactivated leads', icon: Target, color: 'bg-emerald-100 text-emerald-600' },
            ].map((item) => (
              <div key={item.step} className="flex items-start gap-3">
                <div className={`h-9 w-9 rounded-lg ${item.color} flex items-center justify-center shrink-0`}>
                  <item.icon className="h-4 w-4" />
                </div>
                <div>
                  <p className="font-medium text-sm">{item.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
