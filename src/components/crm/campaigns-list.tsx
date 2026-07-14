'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Megaphone, Plus, Mail, MessageSquare, Play, Pause, Zap, Loader2,
  BarChart3, ListFilter, TrendingUp, ArrowRight, LayoutGrid, List, Sparkles,
  Pencil, Trash2, Users, AlertTriangle,
} from 'lucide-react'
import { toast } from 'sonner'
import { CampaignBuilder, type PipelineStageOption, type EditingCampaign } from './campaign-builder'
import { CampaignAnalytics } from './campaign-analytics'
import { CampaignPerformance } from './campaign-performance'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { previewPersonalize } from '@/lib/campaigns/personalization'
import { CAMPAIGN_TEMPLATES } from '@/lib/campaigns/templates'
import type { Campaign } from '@/types/database'

// One glyph per channel — same ink weight, no rainbow. The accent stays
// reserved for live status, per the Aurea editorial system.
function channelMeta(channel: string) {
  if (channel === 'sms') return { Icon: MessageSquare, label: 'SMS' }
  if (channel === 'email') return { Icon: Mail, label: 'Email' }
  return { Icon: Zap, label: 'Multi-channel' }
}

type PrequalMode = 'inherit' | 'enabled' | 'disabled'

/**
 * Compact per-campaign financing prequal control. 'inherit' follows the account
 * default; 'enabled'/'disabled' scope this one campaign (tighten-only — a
 * campaign can veto but never widen the account flag). PATCHes playbook.prequal_mode.
 */
function PrequalControl({ campaignId, initial }: { campaignId: string; initial: PrequalMode }) {
  const [mode, setMode] = useState<PrequalMode>(initial)
  const [saving, setSaving] = useState(false)

  async function change(next: PrequalMode) {
    const prev = mode
    setMode(next) // optimistic
    setSaving(true)
    try {
      const res = await fetch(`/api/campaigns/${campaignId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prequal_mode: next }),
      })
      if (!res.ok) throw new Error('failed')
      toast.success(
        next === 'inherit'
          ? 'Prequal follows the account default for this campaign.'
          : next === 'disabled'
            ? 'Prequal turned off for this campaign.'
            : 'Prequal enabled for this campaign (still requires the account switch on).'
      )
    } catch {
      setMode(prev) // revert
      toast.error('Could not update prequal setting')
    } finally {
      setSaving(false)
    }
  }

  return (
    <label className="hidden items-center gap-1.5 text-[11px] text-aurea-ink-3 lg:inline-flex" title="Financing pre-qualification for this campaign">
      <span className="uppercase tracking-[0.12em]">Prequal</span>
      <select
        value={mode}
        disabled={saving}
        onChange={(e) => change(e.target.value as PrequalMode)}
        className="rounded-md bg-transparent px-1.5 py-1 text-[11px] font-medium text-aurea-ink-2 ring-1 ring-inset ring-aurea-border transition-colors hover:text-aurea-ink focus:outline-none disabled:opacity-60"
      >
        <option value="inherit">Account default</option>
        <option value="enabled">On</option>
        <option value="disabled">Off</option>
      </select>
    </label>
  )
}

// Status as a dot + colored word: emerald = running, amber = paused,
// gold = finished, muted ink = draft.
const STATUS_META: Record<string, { dot: string; text: string; label: string }> = {
  active: { dot: 'bg-aurea-primary', text: 'text-aurea-primary', label: 'Active' },
  paused: { dot: 'bg-aurea-amber', text: 'text-aurea-amber', label: 'Paused' },
  draft: { dot: 'bg-aurea-ink-3', text: 'text-aurea-ink-3', label: 'Draft' },
  completed: { dot: 'bg-aurea-gold', text: 'text-aurea-gold', label: 'Completed' },
}

/**
 * Pre-activation confirmation. Before a one-click activate enrolls the whole
 * audience, resolve and show (a) how many leads will be enrolled and (b) a
 * rendered preview of step 1 with sample data — so activating is a deliberate,
 * eyes-open action rather than a surprise blast.
 *
 * Audience count reuses existing endpoints (no new route): the Smart List's
 * leads count for smart_list mode, or the sum of per-stage lead counts for
 * stages mode. Falls back to a plain description if the count can't be resolved.
 */
function ActivationConfirm({ campaign, onClose }: { campaign: Campaign; onClose: () => void }) {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [count, setCount] = useState<number | null>(null)
  const [audienceLabel, setAudienceLabel] = useState('')
  const [step1, setStep1] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function resolve() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let smartListId: string | null = (campaign as any).smart_list_id ?? null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let stageList: string[] = Array.isArray((campaign.target_criteria as any)?.stages)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? ((campaign.target_criteria as any).stages as string[])
        : []

      // Pull the full campaign for step bodies (the list only carries counts).
      try {
        const res = await fetch(`/api/campaigns/${campaign.id}`)
        if (res.ok) {
          const { campaign: full } = await res.json()
          smartListId = full.smart_list_id ?? smartListId
          if (Array.isArray(full.target_criteria?.stages)) stageList = full.target_criteria.stages
          const first = (full.steps ?? [])
            .slice()
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .sort((a: any, b: any) => (a.step_number ?? 0) - (b.step_number ?? 0))[0]
          if (first?.body_template && !cancelled) setStep1(previewPersonalize(first.body_template))
        }
      } catch { /* preview is best-effort */ }

      // Resolve the audience count via existing endpoints.
      try {
        if (smartListId) {
          const r = await fetch(`/api/smart-lists/${smartListId}/leads?page=1&per_page=1`)
          if (r.ok) {
            const d = await r.json()
            if (!cancelled) { setCount(d.pagination?.total ?? 0); setAudienceLabel('matching this Smart List') }
          }
        } else if (stageList.length > 0) {
          const totals = await Promise.all(
            stageList.map(async (sid) => {
              const r = await fetch(`/api/leads?stage_id=${sid}&page=1&per_page=1`)
              if (!r.ok) return 0
              const d = await r.json()
              return d.pagination?.total ?? 0
            })
          )
          if (!cancelled) {
            setCount(totals.reduce((a, b) => a + b, 0))
            setAudienceLabel(`across ${stageList.length} pipeline stage${stageList.length > 1 ? 's' : ''}`)
          }
        } else if (!cancelled) {
          setCount(null)
          setAudienceLabel('all leads (manual targeting)')
        }
      } catch { /* fall back to the description-only view */ }

      if (!cancelled) setLoading(false)
    }
    resolve()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign.id])

  async function confirm() {
    setConfirming(true)
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/activate`, { method: 'POST' })
      if (!res.ok) throw new Error('failed')
      toast.success('Campaign activated! Leads will be enrolled automatically.')
      onClose()
      router.refresh()
    } catch {
      toast.error('Failed to activate campaign')
      setConfirming(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="aurea max-w-lg bg-aurea-surface">
        <DialogHeader className="space-y-1">
          <p className="aurea-eyebrow">Activate campaign</p>
          <DialogTitle
            className="text-[22px] font-normal tracking-[-0.015em] text-aurea-ink"
            style={{ fontFamily: 'var(--font-instrument-serif), "Newsreader", Georgia, serif' }}
          >
            {campaign.name}
          </DialogTitle>
        </DialogHeader>

        <div className="mt-4 space-y-4">
          {/* Audience */}
          <div className="rounded-lg border border-aurea-border p-3.5">
            <p className="aurea-eyebrow mb-1.5">Audience</p>
            {loading ? (
              <p className="flex items-center gap-2 text-[13px] text-aurea-ink-3">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Resolving audience…
              </p>
            ) : (
              <p className="flex items-center gap-1.5 text-[14px] text-aurea-ink">
                <Users className="h-4 w-4 text-aurea-ink-3" />
                {count !== null ? (
                  <>
                    <span className="font-medium tabular-nums">{count.toLocaleString()}</span>
                    <span className="text-aurea-ink-2">lead{count === 1 ? '' : 's'} {audienceLabel}</span>
                  </>
                ) : (
                  <span className="text-aurea-ink-2">Will enroll {audienceLabel}</span>
                )}
              </p>
            )}
          </div>

          {/* Step 1 preview */}
          {step1 && (
            <div className="rounded-lg border border-aurea-border p-3.5">
              <p className="aurea-eyebrow mb-1.5">First message preview</p>
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-aurea-ink-2">{step1}</p>
            </div>
          )}

          {/* Warning */}
          <div className="flex items-start gap-2 rounded-lg bg-aurea-amber/10 p-3 text-[12.5px] text-aurea-ink-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-aurea-amber" />
            <span>This will enroll leads immediately and begin sending. You can pause the campaign at any time.</span>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 border-t pt-4">
            <Button variant="outline" onClick={onClose} disabled={confirming}>Cancel</Button>
            <Button onClick={confirm} disabled={confirming} className="gap-1.5">
              {confirming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" strokeWidth={2} />}
              Activate campaign
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function CampaignsList({ campaigns: initial, initialSmartListId, stages = [] }: { campaigns: Campaign[]; initialSmartListId?: string; stages?: PipelineStageOption[] }) {
  const [campaigns, setCampaigns] = useState(initial)
  const [deploying, setDeploying] = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)
  const [viewingAnalytics, setViewingAnalytics] = useState<string | null>(null)
  const [viewingPerformance, setViewingPerformance] = useState(false)
  const [templateView, setTemplateView] = useState<'card' | 'list'>('card')
  // Activate → confirm modal; edit → pre-filled builder; delete → confirm.
  const [activating, setActivating] = useState<Campaign | null>(null)
  const [editing, setEditing] = useState<EditingCampaign | null>(null)
  const [deleting, setDeleting] = useState<Campaign | null>(null)
  const [openingEdit, setOpeningEdit] = useState<string | null>(null)
  const router = useRouter()

  // Read after mount — the server render can't know the saved preference,
  // and reading localStorage in the initializer would mismatch hydration.
  useEffect(() => {
    const saved = localStorage.getItem('campaigns:template-view')
    if (saved === 'list') setTemplateView('list')
  }, [])

  function switchTemplateView(view: 'card' | 'list') {
    setTemplateView(view)
    localStorage.setItem('campaigns:template-view', view)
  }

  async function deployTemplate(templateId: string) {
    const template = CAMPAIGN_TEMPLATES.find((t) => t.id === templateId)
    if (!template) return

    setDeploying(templateId)
    try {
      const res = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: template.name,
          description: template.description,
          type: template.type,
          channel: template.channel,
          target_criteria: template.target_criteria,
          send_window: template.send_window,
          steps: template.steps,
        }),
      })

      if (!res.ok) throw new Error('Failed to create')
      toast.success(`"${template.name}" campaign created! Activate it to start sending.`)
      router.refresh()
    } catch {
      toast.error('Failed to create campaign')
    } finally {
      setDeploying(null)
    }
  }

  async function toggleCampaign(id: string, currentStatus: string) {
    setToggling(id)
    const action = currentStatus === 'active' ? 'pause' : 'activate'
    try {
      const res = await fetch(`/api/campaigns/${id}/${action}`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed')
      toast.success(action === 'activate' ? 'Campaign activated! Leads will be enrolled automatically.' : 'Campaign paused.')
      router.refresh()
    } catch {
      toast.error(`Failed to ${action} campaign`)
    } finally {
      setToggling(null)
    }
  }

  // Fetch the full campaign (with step bodies) then open the builder in edit mode.
  async function openEdit(campaign: Campaign) {
    setOpeningEdit(campaign.id)
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}`)
      if (!res.ok) throw new Error('failed')
      const { campaign: full } = await res.json()
      setEditing(full as EditingCampaign)
    } catch {
      toast.error('Could not open campaign for editing')
    } finally {
      setOpeningEdit(null)
    }
  }

  // Optimistic archive with rollback (matches the PrequalControl pattern). The
  // server returns 409 for an active campaign — surfaced as a toast on rollback.
  async function deleteCampaign(campaign: Campaign) {
    const prev = campaigns
    setCampaigns((cs) => cs.filter((c) => c.id !== campaign.id)) // optimistic
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to delete campaign')
      }
      toast.success('Campaign archived.')
      router.refresh()
    } catch (e) {
      setCampaigns(prev) // rollback
      toast.error(e instanceof Error ? e.message : 'Failed to delete campaign')
    }
  }

  // Show performance dashboard
  if (viewingPerformance) {
    return (
      <CampaignPerformance
        campaigns={campaigns}
        onBack={() => setViewingPerformance(false)}
      />
    )
  }

  // Show analytics view for a specific campaign
  if (viewingAnalytics) {
    return (
      <CampaignAnalytics
        campaignId={viewingAnalytics}
        onBack={() => setViewingAnalytics(null)}
      />
    )
  }

  // Archived campaigns are soft-deleted — hide them from the live list.
  const visible = campaigns.filter((c) => c.status !== 'archived')
  const activeCount = visible.filter((c) => c.status === 'active').length

  return (
    <div className="animate-in fade-in-0 duration-500">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="flex flex-col gap-5 border-b border-aurea-border pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="aurea-eyebrow mb-3">Automation</p>
          <h1 className="aurea-display text-[40px] text-aurea-ink sm:text-[48px]">
            Campaigns
          </h1>
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-aurea-ink-2">
            Automated SMS and email sequences that nurture every lead around the clock —
            deploy a proven playbook, or compose one of your own.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2.5">
          <a
            href="/campaigns/setup"
            className="inline-flex items-center gap-1.5 rounded-md px-3.5 py-2 text-[13px] font-medium text-aurea-ink-2 ring-1 ring-inset ring-aurea-border transition-colors hover:bg-aurea-surface-2 hover:text-aurea-ink"
          >
            <Sparkles className="h-4 w-4" strokeWidth={1.75} />
            Campaign setup
          </a>
          <button
            onClick={() => setViewingPerformance(true)}
            className="inline-flex items-center gap-1.5 rounded-md px-3.5 py-2 text-[13px] font-medium text-aurea-ink-2 ring-1 ring-inset ring-aurea-border transition-colors hover:bg-aurea-surface-2 hover:text-aurea-ink"
          >
            <TrendingUp className="h-4 w-4" strokeWidth={1.75} />
            Performance
          </button>
          <CampaignBuilder initialSmartListId={initialSmartListId} autoOpen={!!initialSmartListId} stages={stages} />
        </div>
      </header>

      {/* ── Playbook templates ─────────────────────────────── */}
      <section className="mt-10">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="aurea-eyebrow mb-2">Playbooks</p>
            <h2 className="aurea-display text-[22px] text-aurea-ink">One-click templates</h2>
          </div>
          <div className="flex items-center gap-3">
            <p className="hidden text-[12px] text-aurea-ink-3 sm:block">
              {CAMPAIGN_TEMPLATES.length} proven sequences · customize after deploy
            </p>
            <div className="flex items-center rounded-md ring-1 ring-inset ring-aurea-border">
              <button
                onClick={() => switchTemplateView('card')}
                aria-label="Card view"
                aria-pressed={templateView === 'card'}
                className={`flex h-8 w-8 items-center justify-center rounded-l-md transition-colors ${
                  templateView === 'card'
                    ? 'bg-aurea-surface-2 text-aurea-ink'
                    : 'text-aurea-ink-3 hover:text-aurea-ink'
                }`}
              >
                <LayoutGrid className="h-4 w-4" strokeWidth={1.75} />
              </button>
              <button
                onClick={() => switchTemplateView('list')}
                aria-label="List view"
                aria-pressed={templateView === 'list'}
                className={`flex h-8 w-8 items-center justify-center rounded-r-md border-l border-aurea-border transition-colors ${
                  templateView === 'list'
                    ? 'bg-aurea-surface-2 text-aurea-ink'
                    : 'text-aurea-ink-3 hover:text-aurea-ink'
                }`}
              >
                <List className="h-4 w-4" strokeWidth={1.75} />
              </button>
            </div>
          </div>
        </div>

        {templateView === 'list' ? (
          <div className="aurea-card mt-5 overflow-hidden">
            {CAMPAIGN_TEMPLATES.map((template, i) => {
              const { Icon, label } = channelMeta(template.channel)
              const isDeploying = deploying === template.id
              return (
                <div
                  key={template.id}
                  className="group flex items-center justify-between gap-4 border-b border-aurea-border px-5 py-4 last:border-0"
                >
                  <div className="flex min-w-0 items-center gap-3.5">
                    <span className="hidden w-8 shrink-0 font-mono text-[11px] tabular-nums text-aurea-ink-3 sm:block">
                      /{String(i + 1).padStart(2, '0')}
                    </span>
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-aurea-surface-2 ring-1 ring-aurea-border">
                      <Icon className="h-4 w-4 text-aurea-ink-2" strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2.5">
                        <p className="truncate text-[14px] font-medium text-aurea-ink">{template.name}</p>
                        <span className="hidden shrink-0 text-[10.5px] uppercase tracking-[0.14em] text-aurea-ink-3 md:inline">
                          {label}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-[12px] text-aurea-ink-3">{template.description}</p>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-4">
                    <p className="hidden font-mono text-[12.5px] tabular-nums text-aurea-ink sm:block">
                      {template.steps.length} <span className="text-aurea-ink-3">steps</span>
                    </p>
                    <button
                      onClick={() => deployTemplate(template.id)}
                      disabled={isDeploying}
                      className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium text-aurea-ink-2 ring-1 ring-inset ring-aurea-border transition-colors hover:bg-aurea-surface-2 hover:text-aurea-ink disabled:opacity-60"
                    >
                      {isDeploying ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Plus className="h-3.5 w-3.5" strokeWidth={2} />
                      )}
                      {isDeploying ? 'Deploying…' : 'Deploy'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {CAMPAIGN_TEMPLATES.map((template, i) => {
            const { Icon, label } = channelMeta(template.channel)
            const isDeploying = deploying === template.id
            return (
              <div key={template.id} className="aurea-card group flex flex-col p-5">
                <div className="flex items-center justify-between">
                  <span className="aurea-eyebrow inline-flex items-center gap-2">
                    <Icon className="h-3.5 w-3.5 text-aurea-ink-3" strokeWidth={1.75} />
                    {label}
                  </span>
                  <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3">
                    /{String(i + 1).padStart(2, '0')}
                  </span>
                </div>

                <div className="mt-4 flex items-baseline gap-2">
                  <span className="aurea-display text-[30px] tabular-nums text-aurea-ink">
                    {template.steps.length}
                  </span>
                  <span className="text-[10.5px] uppercase tracking-[0.14em] text-aurea-ink-3">
                    steps
                  </span>
                </div>

                <h3 className="mt-3 text-[15px] font-medium text-aurea-ink">{template.name}</h3>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-aurea-ink-3">
                  {template.description}
                </p>

                <button
                  onClick={() => deployTemplate(template.id)}
                  disabled={isDeploying}
                  className="mt-auto flex items-center gap-1.5 border-t border-aurea-border pt-3.5 text-[12.5px] font-medium text-aurea-ink-2 transition-colors hover:text-aurea-ink disabled:opacity-60"
                >
                  {isDeploying ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="h-3.5 w-3.5" strokeWidth={2} />
                  )}
                  {isDeploying ? 'Deploying…' : 'Deploy template'}
                  {!isDeploying && (
                    <ArrowRight className="ml-auto h-3.5 w-3.5 text-aurea-ink-3 transition-all group-hover:translate-x-0.5 group-hover:text-aurea-primary" />
                  )}
                </button>
              </div>
            )
          })}
        </div>
        )}
      </section>

      {/* ── Existing campaigns ─────────────────────────────── */}
      <section className="mt-12">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="aurea-eyebrow mb-2">Live</p>
            <h2 className="aurea-display text-[22px] text-aurea-ink">Your campaigns</h2>
          </div>
          {visible.length > 0 && (
            <p className="hidden text-[12px] text-aurea-ink-3 sm:block">
              <span className="text-aurea-ink">{activeCount}</span> active of {visible.length}
            </p>
          )}
        </div>

        {visible.length === 0 ? (
          <div className="mt-5 rounded-xl border border-dashed border-aurea-border p-12 text-center">
            <Megaphone className="mx-auto mb-3 h-9 w-9 text-aurea-ink-3" strokeWidth={1.5} />
            <p className="text-[14px] font-medium text-aurea-ink">No campaigns yet</p>
            <p className="mt-1 text-[12.5px] text-aurea-ink-3">
              Deploy a template above, or build one from scratch.
            </p>
          </div>
        ) : (
          <div className="aurea-card mt-5 overflow-hidden">
            {visible.map((campaign) => {
              const { Icon } = channelMeta(campaign.channel)
              const status = STATUS_META[campaign.status] ?? STATUS_META.draft
              const enrolled = campaign.total_enrolled ?? 0
              const completed = campaign.total_completed ?? 0
              const converted = campaign.total_converted ?? 0
              const isToggling = toggling === campaign.id
              return (
                <div
                  key={campaign.id}
                  className="flex items-center justify-between gap-4 border-b border-aurea-border px-5 py-4 last:border-0"
                >
                  <div className="flex min-w-0 items-center gap-3.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-aurea-surface-2 ring-1 ring-aurea-border">
                      <Icon className="h-4 w-4 text-aurea-ink-2" strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2.5">
                        <p className="truncate text-[14px] font-medium text-aurea-ink">{campaign.name}</p>
                        <span className="inline-flex shrink-0 items-center gap-1.5">
                          <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
                          <span className={`text-[11px] font-medium ${status.text}`}>{status.label}</span>
                        </span>
                      </div>
                      {campaign.description && (
                        <p className="mt-0.5 truncate text-[12px] text-aurea-ink-3">{campaign.description}</p>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-4">
                    <div className="hidden text-right md:block">
                      <p className="font-mono text-[12.5px] tabular-nums text-aurea-ink">{enrolled} enrolled</p>
                      <p className="text-[11px] text-aurea-ink-3">{completed} done · {converted} won</p>
                      {(campaign as any).smart_list_name && (
                        <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-aurea-ink-3">
                          <ListFilter className="h-3 w-3" style={{ color: (campaign as any).smart_list_color }} />
                          {(campaign as any).smart_list_name}
                        </p>
                      )}
                    </div>

                    <PrequalControl
                      campaignId={campaign.id}
                      initial={(campaign.playbook?.prequal_mode as PrequalMode) ?? 'inherit'}
                    />

                    <button
                      onClick={() => setViewingAnalytics(campaign.id)}
                      className="inline-flex items-center gap-1.5 text-[12px] font-medium text-aurea-ink-3 transition-colors hover:text-aurea-ink"
                    >
                      <BarChart3 className="h-4 w-4" strokeWidth={1.75} />
                      <span className="hidden sm:inline">Analytics</span>
                    </button>

                    <button
                      onClick={() => openEdit(campaign)}
                      disabled={openingEdit === campaign.id}
                      aria-label="Edit campaign"
                      title="Edit campaign"
                      className="inline-flex items-center text-aurea-ink-3 transition-colors hover:text-aurea-ink disabled:opacity-60"
                    >
                      {openingEdit === campaign.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Pencil className="h-4 w-4" strokeWidth={1.75} />
                      )}
                    </button>

                    <button
                      onClick={() => setDeleting(campaign)}
                      aria-label="Delete campaign"
                      title="Delete campaign"
                      className="inline-flex items-center text-aurea-ink-3 transition-colors hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                    </button>

                    {campaign.status === 'draft' || campaign.status === 'paused' ? (
                      <button
                        onClick={() => setActivating(campaign)}
                        disabled={isToggling}
                        className="inline-flex items-center gap-1.5 rounded-md bg-aurea-primary-soft px-3 py-1.5 text-[12px] font-medium text-aurea-primary ring-1 ring-inset ring-aurea-primary/20 transition-colors hover:bg-aurea-primary hover:text-white disabled:opacity-60"
                      >
                        <Play className="h-3.5 w-3.5" strokeWidth={2} />
                        Activate
                      </button>
                    ) : campaign.status === 'active' ? (
                      <button
                        onClick={() => toggleCampaign(campaign.id, campaign.status)}
                        disabled={isToggling}
                        className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium text-aurea-ink-2 ring-1 ring-inset ring-aurea-border transition-colors hover:bg-aurea-surface-2 hover:text-aurea-ink disabled:opacity-60"
                      >
                        {isToggling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pause className="h-3.5 w-3.5" strokeWidth={2} />}
                        Pause
                      </button>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* Pre-activation confirmation (audience count + step-1 preview). */}
      {activating && (
        <ActivationConfirm campaign={activating} onClose={() => setActivating(null)} />
      )}

      {/* Edit — the builder in controlled edit mode, pre-filled from the campaign. */}
      {editing && (
        <CampaignBuilder
          editingCampaign={editing}
          open={!!editing}
          onOpenChange={(o) => { if (!o) setEditing(null) }}
          stages={stages}
        />
      )}

      {/* Delete — archive with a confirm gate. */}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => { if (!o) setDeleting(null) }}
        title="Delete this campaign?"
        description={
          deleting?.status === 'active'
            ? 'This campaign is active. Pause it first — active campaigns can’t be deleted.'
            : 'The campaign will be archived and removed from your list. Enrolled leads stop receiving its messages.'
        }
        confirmLabel="Delete campaign"
        cancelLabel="Cancel"
        destructive
        onConfirm={() => { if (deleting) return deleteCampaign(deleting) }}
      />
    </div>
  )
}
