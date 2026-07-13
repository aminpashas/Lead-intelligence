'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { ACTIVE_CALL_STATUSES, ACTIVE_CALL_MAX_AGE_MINUTES, type CallMetric } from '@/lib/voice/call-metrics'
import {
  Phone, PhoneCall, PhoneOff, PhoneMissed,
  Radio, Loader2, Play, Pause, Plus,
  Clock, Calendar, TrendingUp,
  Mic, FileText, AlertCircle, CheckCircle,
  VolumeX, BarChart3, Voicemail, Search,
  RefreshCw, Sparkles, XCircle, Ban, ArrowUpRight,
  ChevronDown, ChevronRight, Bot, User, ArrowRight,
  ShieldAlert, HelpCircle,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import type { Lead } from '@/types/database'
import { LeadActions } from '@/components/crm/lead-actions'
import { CallRecordingPlayer } from '@/components/voice/call-recording-player'
import { recordingPlaybackUrl } from '@/lib/voice/recording-playback'
import { toTranscriptLines } from '@/lib/voice/transcript'

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

type CallReviewFlag = {
  category?: string
  severity?: 'critical' | 'warning'
  summary?: string
  evidence?: string
  recommended_action?: string
}

type VoiceCallRow = {
  id: string
  direction: 'inbound' | 'outbound'
  status: string
  from_number: string
  to_number: string
  duration_seconds: number
  outcome: string | null
  review_status: 'pending' | 'clear' | 'flagged' | 'escalated' | null
  review_flags: CallReviewFlag[] | null
  transcript_summary: string | null
  transcript: unknown
  recording_url: string | null
  agent_type: string | null
  voice_campaign_id: string | null
  created_at: string
  // Full lead so the inline action bar can gate Call/SMS/Email on phone,
  // email and the per-channel opt-out flags.
  lead?: Lead | null
}

type VoiceCampaignRow = {
  id: string
  name: string
  description: string | null
  status: string
  agent_type: string
  total_leads: number
  total_called: number
  total_connected: number
  total_appointments: number
  total_voicemails: number
  total_no_answer: number
  total_do_not_call: number
  avg_call_duration_seconds: number
  calls_per_hour: number
  active_hours_start: number
  active_hours_end: number
  created_at: string
}

type Props = {
  recentCalls: VoiceCallRow[]
  campaigns: VoiceCampaignRow[]
  orgSettings: Record<string, unknown>
  stats: {
    todayCalls: number
    todayConnected: number
    todayAppointments: number
    activeCalls: number
  }
}

// ═══════════════════════════════════════════════════════════════
// STATUS BADGES
// call status semantics: live/connected/active=emerald, ringing/queued=amber,
// failed/missed=rose, ended/idle=neutral ink
// ═══════════════════════════════════════════════════════════════

const callStatusConfig: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  initiated: { label: 'Dialing', color: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20', icon: Phone },
  ringing: { label: 'Ringing', color: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20', icon: PhoneCall },
  in_progress: { label: 'Live', color: 'bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20 animate-pulse', icon: Radio },
  completed: { label: 'Completed', color: 'bg-aurea-surface-2 text-aurea-ink-2 border border-aurea-border', icon: CheckCircle },
  no_answer: { label: 'No Answer', color: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20', icon: PhoneMissed },
  busy: { label: 'Busy', color: 'bg-aurea-rose/10 text-aurea-rose border border-aurea-rose/20', icon: PhoneOff },
  failed: { label: 'Failed', color: 'bg-aurea-rose/10 text-aurea-rose border border-aurea-rose/20', icon: AlertCircle },
  voicemail: { label: 'Voicemail', color: 'bg-aurea-surface-2 text-aurea-ink-2 border border-aurea-border', icon: Voicemail },
  canceled: { label: 'Canceled', color: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border', icon: PhoneOff },
}

const outcomeConfig: Record<string, { label: string; color: string; icon: LucideIcon }> = {
  appointment_booked: { label: 'Booked', icon: Calendar, color: 'bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20' },
  callback_requested: { label: 'Callback', icon: RefreshCw, color: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20' },
  interested: { label: 'Interested', icon: Sparkles, color: 'bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20' },
  not_interested: { label: 'Not Interested', icon: XCircle, color: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border' },
  wrong_number: { label: 'Wrong #', icon: AlertCircle, color: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20' },
  do_not_call: { label: 'DNC', icon: Ban, color: 'bg-aurea-rose/10 text-aurea-rose border border-aurea-rose/20' },
  voicemail_left: { label: 'VM Left', icon: Voicemail, color: 'bg-aurea-surface-2 text-aurea-ink-2 border border-aurea-border' },
  no_answer: { label: 'No Answer', icon: PhoneMissed, color: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20' },
  technical_failure: { label: 'Error', icon: AlertCircle, color: 'bg-aurea-rose/10 text-aurea-rose border border-aurea-rose/20' },
  transferred: { label: 'Transferred', icon: ArrowUpRight, color: 'bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20' },
}

// Post-call AI review verdicts. 'clear' stays silent (no badge noise on the
// happy path); flagged/escalated demand attention.
const reviewStatusConfig: Record<string, { label: string; color: string }> = {
  escalated: { label: 'Escalated', color: 'bg-aurea-rose/10 text-aurea-rose border border-aurea-rose/20' },
  flagged: { label: 'Flagged', color: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20' },
}

// Neutral badge for a row stuck in an active status past the live-freshness bound:
// its terminal event never arrived, so it's a phantom, not a live call.
const strandedStatusConfig = { label: 'Ended', color: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border', icon: PhoneOff }

/**
 * A `voice_calls` row in an active status (initiated/ringing/in_progress) but older
 * than the live-freshness bound is a stranded phantom — the reconciler will close it
 * out of band, but until then the list must not advertise it as "Live"/"Ringing".
 * Mirrors the guard the Live Now stat card uses (see applyCallMetric 'active').
 */
function isStrandedActiveCall(call: { status: string; created_at: string }): boolean {
  if (!(ACTIVE_CALL_STATUSES as readonly string[]).includes(call.status)) return false
  return new Date(call.created_at).getTime() < Date.now() - ACTIVE_CALL_MAX_AGE_MINUTES * 60_000
}

/** Status badge config, downgrading stranded active rows to a neutral "Ended". */
function effectiveStatusConfig(call: { status: string; created_at: string }) {
  if (isStrandedActiveCall(call)) return strandedStatusConfig
  return callStatusConfig[call.status] || callStatusConfig.completed
}

function prettifyOutcome(outcome: string): string {
  return outcome.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Every finished call must show a clear outcome: known outcomes use their
 * config, unknown strings are prettified (never a silent blank), and a
 * completed call with no outcome yet reads "Needs Review".
 */
function resolveOutcomeBadge(call: { outcome: string | null; status: string }): { label: string; color: string; icon: LucideIcon } | null {
  if (call.outcome) {
    return (
      outcomeConfig[call.outcome] ?? {
        label: prettifyOutcome(call.outcome),
        icon: HelpCircle,
        color: 'bg-aurea-surface-2 text-aurea-ink-2 border border-aurea-border',
      }
    )
  }
  if (call.status === 'completed') {
    return {
      label: 'Needs Review',
      icon: HelpCircle,
      color: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20',
    }
  }
  return null
}

const campaignStatusColors: Record<string, string> = {
  draft: 'bg-aurea-surface-2 text-aurea-ink-2 border border-aurea-border',
  scheduled: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20',
  active: 'bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20',
  paused: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20',
  completed: 'bg-aurea-surface-2 text-aurea-ink-2 border border-aurea-border',
  archived: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border',
}

// ═══════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════

export function CallCenterDashboard({ recentCalls, campaigns, orgSettings, stats }: Props) {
  const [calls] = useState(recentCalls)
  const [search, setSearch] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [campaignAction, setCampaignAction] = useState<string | null>(null)
  const router = useRouter()

  const voiceEnabled = orgSettings?.voice_enabled as boolean

  // Filter calls by search
  const filteredCalls = calls.filter(c => {
    if (!search) return true
    const s = search.toLowerCase()
    const name = `${c.lead?.first_name || ''} ${c.lead?.last_name || ''}`.toLowerCase()
    return name.includes(s) || c.from_number.includes(s) || c.to_number.includes(s) || (c.outcome || '').includes(s)
  })

  // Campaign actions
  async function toggleCampaign(campaignId: string, action: 'start' | 'pause') {
    setCampaignAction(campaignId)
    try {
      const res = await fetch('/api/voice/campaign', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaign_id: campaignId, action }),
      })
      if (!res.ok) throw new Error('Failed')
      toast.success(action === 'start' ? 'Campaign started! Calls are being initiated.' : 'Campaign paused.')
      router.refresh()
    } catch {
      toast.error(`Failed to ${action} campaign`)
    } finally {
      setCampaignAction(null)
    }
  }

  return (
    <div className="animate-in fade-in-0 duration-500 space-y-8">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="border-b border-aurea-border pb-8 flex items-start justify-between">
        <div>
          <p className="aurea-eyebrow mb-3">Voice</p>
          <h1 className="aurea-display text-[36px] text-aurea-ink sm:text-[46px]">Call Center</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-aurea-ink-3">AI-powered inbound &amp; outbound voice calling</p>
        </div>
        <div className="mt-2 flex items-center gap-2">
          {voiceEnabled ? (
            <Badge className="bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20 gap-1.5 font-medium">
              <Radio className="h-3 w-3 animate-pulse" strokeWidth={1.75} /> Voice Active
            </Badge>
          ) : (
            <Badge className="bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border gap-1.5">
              <VolumeX className="h-3 w-3" strokeWidth={1.75} /> Voice Disabled
            </Badge>
          )}
        </div>
      </header>

      {/* ── Stats Cards ────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          index="/01"
          label="Today's Calls"
          value={stats.todayCalls}
          icon={Phone}
          metric="today"
        />
        <StatCard
          index="/02"
          label="Connected"
          value={stats.todayConnected}
          icon={PhoneCall}
          subtext={stats.todayCalls > 0 ? `${Math.round(stats.todayConnected / stats.todayCalls * 100)}% connect rate` : undefined}
          accent
          metric="connected"
        />
        <StatCard
          index="/03"
          label="Appointments"
          value={stats.todayAppointments}
          icon={Calendar}
          accent
          metric="appointments"
        />
        <StatCard
          index="/04"
          label="Live Now"
          value={stats.activeCalls}
          icon={Radio}
          pulse={stats.activeCalls > 0}
          accent={stats.activeCalls > 0}
          metric="active"
        />
      </div>

      {/* ── Tabs: Calls / Campaigns ───────────────────────── */}
      <Tabs defaultValue="calls">
        <TabsList>
          <TabsTrigger value="calls" className="gap-1.5">
            <PhoneCall className="h-4 w-4" strokeWidth={1.75} /> Recent Calls
          </TabsTrigger>
          <TabsTrigger value="campaigns" className="gap-1.5">
            <Mic className="h-4 w-4" strokeWidth={1.75} /> Voice Campaigns
          </TabsTrigger>
        </TabsList>

        {/* ── Calls Tab ──────────────────────────────────── */}
        <TabsContent value="calls" className="mt-4 space-y-4">
          {/* Search */}
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-aurea-ink-3" strokeWidth={1.75} />
            <Input
              placeholder="Search calls by name, number, outcome..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          {filteredCalls.length === 0 ? (
            <div className="aurea-card flex flex-col items-center py-16">
              <Phone className="h-9 w-9 text-aurea-ink-3 mb-4" strokeWidth={1.5} />
              <p className="font-medium text-aurea-ink">No calls recorded yet</p>
              <p className="text-sm text-aurea-ink-3 mt-1">Calls will appear here once the voice system is active</p>
            </div>
          ) : (
            <div className="aurea-card divide-y divide-aurea-border overflow-hidden">
              {filteredCalls.map(call => (
                <CallRow
                  key={call.id}
                  call={call}
                  expanded={expandedId === call.id}
                  onToggle={() => setExpandedId(id => (id === call.id ? null : call.id))}
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Campaigns Tab ──────────────────────────────── */}
        <TabsContent value="campaigns" className="mt-4 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-aurea-ink-3">
              Automated outbound calling campaigns with AI agents
            </p>
            <NewCampaignDialog onCreated={() => router.refresh()} />
          </div>

          {campaigns.length === 0 ? (
            <div className="aurea-card flex flex-col items-center py-16">
              <Mic className="h-9 w-9 text-aurea-ink-3 mb-4" strokeWidth={1.5} />
              <p className="font-medium text-aurea-ink">No voice campaigns yet</p>
              <p className="text-sm text-aurea-ink-3 mt-1">Create a campaign to start auto-dialing leads with AI</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {campaigns.map(campaign => {
                const connectRate = campaign.total_called > 0
                  ? Math.round(campaign.total_connected / campaign.total_called * 100)
                  : 0
                const appointmentRate = campaign.total_connected > 0
                  ? Math.round(campaign.total_appointments / campaign.total_connected * 100)
                  : 0

                return (
                  <div key={campaign.id} className="aurea-card p-5">
                    {/* Header */}
                    <div className="flex items-start justify-between mb-4">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-semibold text-aurea-ink">{campaign.name}</h3>
                          <Badge className={campaignStatusColors[campaign.status]}>
                            {campaign.status}
                          </Badge>
                        </div>
                        {campaign.description && (
                          <p className="text-xs text-aurea-ink-3">{campaign.description}</p>
                        )}
                      </div>
                      <Badge variant="outline" className="text-xs capitalize text-aurea-ink-2">
                        {campaign.agent_type} Agent
                      </Badge>
                    </div>

                    {/* Stats Grid */}
                    <div className="grid grid-cols-4 gap-2 mb-4">
                      <MiniStat label="Leads" value={campaign.total_leads} />
                      <MiniStat label="Called" value={campaign.total_called} />
                      <MiniStat label="Connected" value={campaign.total_connected} highlight={connectRate > 50} />
                      <MiniStat label="Booked" value={campaign.total_appointments} highlight />
                    </div>

                    {/* Progress bar */}
                    <div className="mb-3">
                      <div className="flex items-center justify-between text-xs text-aurea-ink-3 mb-1.5">
                        <span>Progress</span>
                        <span className="font-mono tabular-nums">{campaign.total_leads > 0 ? Math.round(campaign.total_called / campaign.total_leads * 100) : 0}%</span>
                      </div>
                      <div className="h-1 rounded-full bg-aurea-surface-2 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-aurea-primary transition-all duration-500"
                          style={{ width: `${campaign.total_leads > 0 ? Math.min(100, campaign.total_called / campaign.total_leads * 100) : 0}%` }}
                        />
                      </div>
                    </div>

                    {/* Rates */}
                    <div className="flex items-center gap-4 text-xs text-aurea-ink-3 mb-4">
                      <span className="flex items-center gap-1">
                        <TrendingUp className="h-3 w-3" strokeWidth={1.75} />
                        <span className="font-mono tabular-nums">{connectRate}%</span> connect
                      </span>
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" strokeWidth={1.75} />
                        <span className="font-mono tabular-nums">{appointmentRate}%</span> book
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" strokeWidth={1.75} />
                        <span className="font-mono tabular-nums">{formatDuration(campaign.avg_call_duration_seconds)}</span> avg
                      </span>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2">
                      {(campaign.status === 'draft' || campaign.status === 'paused') && (
                        <Button
                          size="sm"
                          className="gap-1.5 flex-1 bg-aurea-primary text-white hover:bg-aurea-primary/90"
                          onClick={() => toggleCampaign(campaign.id, 'start')}
                          disabled={campaignAction === campaign.id}
                        >
                          {campaignAction === campaign.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" strokeWidth={1.75} />}
                          {campaign.status === 'draft' ? 'Start Campaign' : 'Resume'}
                        </Button>
                      )}
                      {campaign.status === 'active' && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5 flex-1"
                          onClick={() => toggleCampaign(campaign.id, 'pause')}
                          disabled={campaignAction === campaign.id}
                        >
                          {campaignAction === campaign.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" strokeWidth={1.75} />}
                          Pause
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" className="gap-1 text-aurea-ink-3">
                        <BarChart3 className="h-4 w-4" strokeWidth={1.75} />
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// CALL ROW — collapsed summary; expands in place to the full
// transcript, recording and a Call / SMS / Email / DND action bar.
// ═══════════════════════════════════════════════════════════════

function CallRow({
  call,
  expanded,
  onToggle,
}: {
  call: VoiceCallRow
  expanded: boolean
  onToggle: () => void
}) {
  const statusCfg = effectiveStatusConfig(call)
  const StatusIcon = statusCfg.icon
  const outcomeCfg = resolveOutcomeBadge(call)
  const reviewCfg = call.review_status ? reviewStatusConfig[call.review_status] : null
  const reviewFlags = (call.review_flags ?? []).filter((f) => f && f.summary)
  const lines = toTranscriptLines(call)
  const live = call.status === 'in_progress' && !isStrandedActiveCall(call)

  return (
    <div className={live ? 'bg-aurea-primary/[0.03]' : undefined}>
      {/* Summary row — click anywhere to expand/collapse */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="group w-full px-5 py-3.5 flex items-center justify-between gap-3 text-left hover:bg-aurea-surface-2 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          {/* Direction indicator */}
          <div className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${
            live ? 'bg-aurea-primary/10' : 'bg-aurea-surface-2'
          }`}>
            {live ? (
              <Radio className="h-[17px] w-[17px] text-aurea-primary animate-pulse" strokeWidth={1.75} />
            ) : call.direction === 'inbound' ? (
              <PhoneCall className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
            ) : (
              <Phone className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
            )}
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-medium text-sm text-aurea-ink truncate">
                {call.lead
                  ? `${call.lead.first_name} ${call.lead.last_name || ''}`.trim()
                  : call.direction === 'inbound' ? maskPhone(call.from_number) : maskPhone(call.to_number)}
              </p>
              <Badge className={statusCfg.color + ' text-[11px] px-1.5 py-0'}>
                <StatusIcon className="h-3 w-3 mr-0.5" />
                {statusCfg.label}
              </Badge>
              {outcomeCfg && (
                <Badge className={outcomeCfg.color + ' inline-flex items-center gap-1 text-[11px] px-1.5 py-0'}>
                  <outcomeCfg.icon className="h-3 w-3" />
                  {outcomeCfg.label}
                </Badge>
              )}
              {reviewCfg && (
                <Badge className={reviewCfg.color + ' inline-flex items-center gap-1 text-[11px] px-1.5 py-0'}>
                  <ShieldAlert className="h-3 w-3" />
                  {reviewCfg.label}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-aurea-ink-3 mt-0.5">
              <span>{call.direction === 'inbound' ? '← Inbound' : '→ Outbound'}</span>
              <span>·</span>
              <span className="flex items-center gap-1 font-mono tabular-nums">
                <Clock className="h-3 w-3" strokeWidth={1.75} />
                {formatDuration(call.duration_seconds)}
              </span>
              {call.agent_type && (
                <>
                  <span>·</span>
                  <span className="capitalize">{call.agent_type} Agent</span>
                </>
              )}
              <span>·</span>
              <span>{formatDate(call.created_at)}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 text-aurea-ink-3">
          {(lines.length > 0 || call.transcript_summary) && (
            <span className="hidden md:inline-flex items-center gap-1.5 text-xs">
              <FileText className="h-3.5 w-3.5" strokeWidth={1.75} />
              Transcript
            </span>
          )}
          {expanded
            ? <ChevronDown className="h-4 w-4" strokeWidth={1.75} />
            : <ChevronRight className="h-4 w-4" strokeWidth={1.75} />}
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-5 pb-5 pt-1 space-y-4 bg-aurea-surface-2/40 animate-in fade-in-0 slide-in-from-top-1 duration-200">
          {/* Action bar — call / text / email the lead without leaving the log */}
          {call.lead ? (
            <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
              <LeadActions lead={call.lead} variant="compact" />
              <a
                href={`/leads/${call.lead.id}`}
                className="inline-flex items-center gap-1 text-xs font-medium text-aurea-ink-3 hover:text-aurea-ink transition-colors"
              >
                View full lead <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} />
              </a>
            </div>
          ) : (
            <p className="text-xs text-aurea-ink-3 pt-1">No linked lead — this number isn’t in your CRM yet.</p>
          )}

          {/* AI review flags — why this call was flagged/escalated */}
          {reviewFlags.length > 0 && (
            <div>
              <p className="aurea-eyebrow mb-2 flex items-center gap-1">
                <ShieldAlert className="h-3 w-3 text-aurea-rose" strokeWidth={1.75} /> AI Review — issues found
              </p>
              <div className="space-y-2">
                {reviewFlags.map((flag, i) => (
                  <div
                    key={i}
                    className={`rounded-lg border p-3 text-[13px] leading-relaxed ${
                      flag.severity === 'critical'
                        ? 'border-aurea-rose/30 bg-aurea-rose/5'
                        : 'border-aurea-amber/30 bg-aurea-amber/5'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <Badge
                        className={
                          (flag.severity === 'critical'
                            ? 'bg-aurea-rose/10 text-aurea-rose border border-aurea-rose/20'
                            : 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20') +
                          ' text-[10px] px-1.5 py-0 uppercase'
                        }
                      >
                        {flag.severity || 'warning'}
                      </Badge>
                      {flag.category && (
                        <span className="text-[11px] text-aurea-ink-3 capitalize">
                          {flag.category.replace(/_/g, ' ')}
                        </span>
                      )}
                    </div>
                    <p className="text-aurea-ink">{flag.summary}</p>
                    {flag.evidence && (
                      <p className="mt-1 text-[12px] italic text-aurea-ink-3">“{flag.evidence}”</p>
                    )}
                    {flag.recommended_action && (
                      <p className="mt-1.5 text-[12px] text-aurea-ink-2">
                        <span className="font-medium">Next step:</span> {flag.recommended_action}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* AI summary (TL;DR above the full transcript) */}
          {call.transcript_summary && (
            <div>
              <p className="aurea-eyebrow mb-2 flex items-center gap-1">
                <Sparkles className="h-3 w-3" strokeWidth={1.75} /> AI Summary
              </p>
              <p className="text-[13px] leading-relaxed text-aurea-ink-2 bg-aurea-surface rounded-lg border border-aurea-border p-3">
                {call.transcript_summary}
              </p>
            </div>
          )}

          {/* Turn-by-turn transcript */}
          <div>
            <p className="aurea-eyebrow mb-2 flex items-center gap-1">
              <FileText className="h-3 w-3" strokeWidth={1.75} /> Transcript
            </p>
            <CallTranscript lines={lines} agentType={call.agent_type} />
          </div>

          {/* Recording */}
          {call.recording_url && (
            <div>
              <p className="aurea-eyebrow mb-2 flex items-center gap-1">
                <Mic className="h-3 w-3" strokeWidth={1.75} /> Recording
              </p>
              <CallRecordingPlayer url={recordingPlaybackUrl(call.id, call.recording_url)!} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// CALL TRANSCRIPT — chat-bubble rendering of role-tagged lines.
// Agent turns hug the right in ink; caller turns sit left on canvas.
// ═══════════════════════════════════════════════════════════════

function CallTranscript({
  lines,
  agentType,
}: {
  lines: ReturnType<typeof toTranscriptLines>
  agentType: string | null
}) {
  const agentName = agentType ? `${agentType[0].toUpperCase()}${agentType.slice(1)}` : 'AI'

  if (lines.length === 0) {
    return <p className="text-[12px] italic text-aurea-ink-3">No transcript captured for this call.</p>
  }

  return (
    <div className="flex flex-col gap-2">
      {lines.map((l, i) => {
        const isAgent = l.role === 'agent'
        return (
          <div key={i} className={`flex flex-col ${isAgent ? 'items-end' : 'items-start'}`}>
            <div className="mb-0.5 flex items-center gap-1 px-1 text-[10px] text-aurea-ink-3">
              {isAgent
                ? <Bot className="h-2.5 w-2.5 text-aurea-primary" strokeWidth={1.75} />
                : <User className="h-2.5 w-2.5" strokeWidth={1.75} />}
              <span>{isAgent ? agentName : 'Caller'}</span>
            </div>
            <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-[13px] leading-[1.5] ${
              isAgent
                ? 'bg-aurea-ink text-aurea-canvas'
                : 'border border-aurea-border bg-aurea-surface text-aurea-ink'
            }`}>
              <p className="whitespace-pre-wrap">{l.content}</p>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// STAT CARD
// ═══════════════════════════════════════════════════════════════

function StatCard({
  index,
  label,
  value,
  icon: Icon,
  subtext,
  pulse,
  accent,
  metric,
}: {
  index: string
  label: string
  value: number
  icon: React.ElementType
  subtext?: string
  pulse?: boolean
  accent?: boolean
  metric?: CallMetric
}) {
  const [open, setOpen] = useState(false)

  const inner = (
    <>
      <div className="flex items-center justify-between mb-4">
        <p className="aurea-eyebrow">{label}</p>
        <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3">{index}</span>
      </div>
      <p className={`aurea-display text-[36px] tabular-nums ${accent ? 'text-aurea-primary' : 'text-aurea-ink'}`}>
        <Icon className={`inline h-[18px] w-[18px] mr-2 mb-1 ${accent ? 'text-aurea-primary' : 'text-aurea-ink-3'} ${pulse ? 'animate-pulse' : ''}`} strokeWidth={1.75} />
        {value}
      </p>
      {subtext && <p className="mt-2 text-[11.5px] text-aurea-ink-3 font-mono tabular-nums">{subtext}</p>}
    </>
  )

  // No drill-down when the card can't map to a list, or the count is zero.
  if (!metric || value === 0) {
    return <div className="aurea-card p-5">{inner}</div>
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`View ${label.toLowerCase()}`}
        className="aurea-card group relative w-full p-5 text-left transition-colors cursor-pointer hover:bg-aurea-surface-2/50 hover:border-aurea-ink/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-aurea-primary/30"
      >
        {inner}
        <span className="absolute bottom-4 right-4 inline-flex items-center gap-1 text-[11px] font-medium text-aurea-ink-3 opacity-0 transition-opacity group-hover:opacity-100">
          View <ArrowRight className="h-3 w-3" strokeWidth={1.75} />
        </span>
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <CallMetricSheet metric={metric} label={label} open={open} />
      </Sheet>
    </>
  )
}

// ═══════════════════════════════════════════════════════════════
// STAT-CARD DRILL-DOWN — slide-over "smart list" of the calls behind
// a stat card, each row linking through to the lead.
// ═══════════════════════════════════════════════════════════════

type DrillCall = {
  id: string
  direction: 'inbound' | 'outbound'
  status: string
  from_number: string
  to_number: string
  duration_seconds: number
  outcome: string | null
  agent_type: string | null
  created_at: string
  lead: Lead | null
}

function CallMetricSheet({ metric, label, open }: { metric: CallMetric; label: string; open: boolean }) {
  const [calls, setCalls] = useState<DrillCall[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/voice/calls/list?metric=${metric}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load this list'))))
      .then((d) => { if (!cancelled) setCalls(d.calls as DrillCall[]) })
      .catch((e) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, metric])

  const count = calls?.length ?? 0

  return (
    <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
      <SheetHeader className="border-b border-aurea-border p-4">
        <SheetTitle className="text-aurea-ink">{label}</SheetTitle>
        <SheetDescription className="text-aurea-ink-3">
          {loading
            ? 'Loading calls…'
            : calls
              ? `${count} ${count === 1 ? 'call' : 'calls'} — tap any to open the lead`
              : 'Calls behind this number'}
        </SheetDescription>
      </SheetHeader>

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-aurea-ink-3" strokeWidth={1.75} />
          </div>
        )}

        {error && !loading && (
          <div className="flex flex-col items-center gap-1 py-16 text-center">
            <AlertCircle className="h-6 w-6 text-aurea-rose" strokeWidth={1.5} />
            <p className="text-sm text-aurea-ink">{error}</p>
          </div>
        )}

        {calls && !loading && calls.length === 0 && (
          <div className="flex flex-col items-center gap-1 py-16 text-center">
            <Phone className="h-6 w-6 text-aurea-ink-3" strokeWidth={1.5} />
            <p className="text-sm text-aurea-ink-3">No calls to show</p>
          </div>
        )}

        {calls && !loading && calls.length > 0 && (
          <div className="divide-y divide-aurea-border">
            {calls.map((call) => (
              <DrillCallRow key={call.id} call={call} />
            ))}
          </div>
        )}
      </div>
    </SheetContent>
  )
}

function DrillCallRow({ call }: { call: DrillCall }) {
  const statusCfg = effectiveStatusConfig(call)
  const StatusIcon = statusCfg.icon
  const outcomeCfg = resolveOutcomeBadge(call)
  const live = call.status === 'in_progress' && !isStrandedActiveCall(call)
  const name = call.lead
    ? `${call.lead.first_name} ${call.lead.last_name || ''}`.trim()
    : call.direction === 'inbound' ? maskPhone(call.from_number) : maskPhone(call.to_number)

  const body = (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${live ? 'bg-aurea-primary/10' : 'bg-aurea-surface-2'}`}>
          {live
            ? <Radio className="h-4 w-4 animate-pulse text-aurea-primary" strokeWidth={1.75} />
            : call.direction === 'inbound'
              ? <PhoneCall className="h-4 w-4 text-aurea-ink-3" strokeWidth={1.75} />
              : <Phone className="h-4 w-4 text-aurea-ink-3" strokeWidth={1.75} />}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="truncate text-sm font-medium text-aurea-ink">{name || 'Unknown'}</p>
            <Badge className={statusCfg.color + ' text-[10px] px-1.5 py-0'}>
              <StatusIcon className="mr-0.5 h-2.5 w-2.5" />
              {statusCfg.label}
            </Badge>
            {outcomeCfg && (
              <Badge className={outcomeCfg.color + ' inline-flex items-center gap-1 text-[10px] px-1.5 py-0'}>
                <outcomeCfg.icon className="h-2.5 w-2.5" />
                {outcomeCfg.label}
              </Badge>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-aurea-ink-3">
            <span>{call.direction === 'inbound' ? '← Inbound' : '→ Outbound'}</span>
            <span>·</span>
            <span className="font-mono tabular-nums">{formatDuration(call.duration_seconds)}</span>
            <span>·</span>
            <span>{formatDate(call.created_at)}</span>
          </div>
        </div>
      </div>
      {call.lead && <ArrowRight className="h-4 w-4 shrink-0 text-aurea-ink-3" strokeWidth={1.75} />}
    </div>
  )

  if (call.lead) {
    return (
      <a href={`/leads/${call.lead.id}`} className="block transition-colors hover:bg-aurea-surface-2">
        {body}
      </a>
    )
  }
  // No linked lead — this number isn't in the CRM, so there's nowhere to go.
  return <div className="cursor-default opacity-80">{body}</div>
}

// ═══════════════════════════════════════════════════════════════
// MINI STAT (for campaign cards)
// ═══════════════════════════════════════════════════════════════

function MiniStat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className="text-center p-2 rounded-md bg-aurea-surface-2">
      <p className={`aurea-display text-[20px] tabular-nums ${highlight ? 'text-aurea-primary' : 'text-aurea-ink'}`}>{value}</p>
      <p className="aurea-eyebrow mt-0.5" style={{ fontSize: '9px' }}>{label}</p>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// NEW CAMPAIGN DIALOG
// ═══════════════════════════════════════════════════════════════

function NewCampaignDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  async function handleCreate() {
    if (!name.trim()) {
      toast.error('Campaign name is required')
      return
    }

    setCreating(true)
    try {
      const res = await fetch('/api/voice/campaign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          agent_type: 'setter',
        }),
      })

      if (!res.ok) throw new Error('Failed')
      toast.success('Voice campaign created! Add leads and start dialing.')
      setOpen(false)
      setName('')
      setDescription('')
      onCreated()
    } catch {
      toast.error('Failed to create campaign')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={
        <Button size="sm" className="gap-1.5 bg-aurea-primary text-white hover:bg-aurea-primary/90">
          <Plus className="h-4 w-4" strokeWidth={1.75} /> New Campaign
        </Button>
      } />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-aurea-ink">
            <Mic className="h-4 w-4 text-aurea-ink-3" strokeWidth={1.75} /> New Voice Campaign
          </DialogTitle>
          <DialogDescription className="text-aurea-ink-3">
            Create an outbound calling campaign. Your AI agent will automatically dial leads and engage them in conversation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label className="aurea-eyebrow mb-1.5 block">Campaign Name</label>
            <Input
              placeholder="e.g., Q1 Reactivation Calls"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="aurea-eyebrow mb-1.5 block">Description (optional)</label>
            <Input
              placeholder="Brief description of the campaign goal"
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            onClick={handleCreate}
            disabled={creating || !name.trim()}
            className="gap-1.5 bg-aurea-primary text-white hover:bg-aurea-primary/90"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" strokeWidth={1.75} />}
            Create Campaign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function formatDuration(seconds: number): string {
  if (!seconds || seconds === 0) return '0s'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m === 0) return `${s}s`
  return `${m}m ${s}s`
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()

  if (isToday) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  }

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) {
    return `Yesterday ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`
  }

  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
}

function maskPhone(phone: string): string {
  if (!phone) return ''
  const clean = phone.replace(/\D/g, '')
  if (clean.length >= 10) {
    return `(***) ***-${clean.slice(-4)}`
  }
  return `***${clean.slice(-4)}`
}
