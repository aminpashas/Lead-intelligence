'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
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
  Phone, PhoneCall, PhoneOff, PhoneMissed,
  Radio, Loader2, Play, Pause, Plus,
  Clock, Users, Calendar, TrendingUp,
  Mic, FileText, AlertCircle, CheckCircle,
  Volume2, VolumeX, BarChart3, Voicemail, Search,
} from 'lucide-react'
import { toast } from 'sonner'

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

type VoiceCallRow = {
  id: string
  direction: 'inbound' | 'outbound'
  status: string
  from_number: string
  to_number: string
  duration_seconds: number
  outcome: string | null
  transcript_summary: string | null
  agent_type: string | null
  voice_campaign_id: string | null
  created_at: string
  lead?: {
    id: string
    first_name: string
    last_name: string | null
    phone: string | null
    ai_qualification: string | null
    status: string
  }
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
// ═══════════════════════════════════════════════════════════════

const callStatusConfig: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  initiated: { label: 'Dialing', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400', icon: Phone },
  ringing: { label: 'Ringing', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400', icon: PhoneCall },
  in_progress: { label: 'Live', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 animate-pulse', icon: Radio },
  completed: { label: 'Completed', color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300', icon: CheckCircle },
  no_answer: { label: 'No Answer', color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400', icon: PhoneMissed },
  busy: { label: 'Busy', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400', icon: PhoneOff },
  failed: { label: 'Failed', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400', icon: AlertCircle },
  voicemail: { label: 'Voicemail', color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400', icon: Voicemail },
  canceled: { label: 'Canceled', color: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400', icon: PhoneOff },
}

const outcomeConfig: Record<string, { label: string; color: string }> = {
  appointment_booked: { label: '📅 Booked', color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' },
  callback_requested: { label: '🔄 Callback', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  interested: { label: '✨ Interested', color: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400' },
  not_interested: { label: '❌ Not Interested', color: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400' },
  wrong_number: { label: '⚠️ Wrong #', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
  do_not_call: { label: '🚫 DNC', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
  voicemail_left: { label: '📞 VM Left', color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' },
  no_answer: { label: '📵 No Answer', color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' },
  technical_failure: { label: '⚠️ Error', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
  transferred: { label: '↗️ Transferred', color: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400' },
}

const campaignStatusColors: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  scheduled: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  active: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  paused: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  completed: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  archived: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
}

// ═══════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════

export function CallCenterDashboard({ recentCalls, campaigns, orgSettings, stats }: Props) {
  const [calls] = useState(recentCalls)
  const [search, setSearch] = useState('')
  const [selectedCall, setSelectedCall] = useState<VoiceCallRow | null>(null)
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
    <div className="space-y-6">
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <Phone className="h-4.5 w-4.5 text-white" />
            </div>
            Call Center
          </h1>
          <p className="text-muted-foreground mt-1">AI-powered inbound & outbound voice calling</p>
        </div>
        <div className="flex items-center gap-2">
          {voiceEnabled ? (
            <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 gap-1">
              <Radio className="h-3 w-3 animate-pulse" /> Voice Active
            </Badge>
          ) : (
            <Badge className="bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 gap-1">
              <VolumeX className="h-3 w-3" /> Voice Disabled
            </Badge>
          )}
        </div>
      </div>

      {/* ── Stats Cards ────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Today's Calls"
          value={stats.todayCalls}
          icon={Phone}
          gradient="from-blue-500 to-indigo-600"
          shadowColor="shadow-blue-500/15"
        />
        <StatCard
          label="Connected"
          value={stats.todayConnected}
          icon={PhoneCall}
          gradient="from-emerald-500 to-teal-600"
          shadowColor="shadow-emerald-500/15"
          subtext={stats.todayCalls > 0 ? `${Math.round(stats.todayConnected / stats.todayCalls * 100)}% connect rate` : undefined}
        />
        <StatCard
          label="Appointments"
          value={stats.todayAppointments}
          icon={Calendar}
          gradient="from-violet-500 to-purple-600"
          shadowColor="shadow-violet-500/15"
        />
        <StatCard
          label="Live Now"
          value={stats.activeCalls}
          icon={Radio}
          gradient="from-rose-500 to-pink-600"
          shadowColor="shadow-rose-500/15"
          pulse={stats.activeCalls > 0}
        />
      </div>

      {/* ── Tabs: Calls / Campaigns ───────────────────────── */}
      <Tabs defaultValue="calls">
        <TabsList>
          <TabsTrigger value="calls" className="gap-1.5">
            <PhoneCall className="h-4 w-4" /> Recent Calls
          </TabsTrigger>
          <TabsTrigger value="campaigns" className="gap-1.5">
            <Mic className="h-4 w-4" /> Voice Campaigns
          </TabsTrigger>
        </TabsList>

        {/* ── Calls Tab ──────────────────────────────────── */}
        <TabsContent value="calls" className="mt-4 space-y-4">
          {/* Search */}
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search calls by name, number, outcome..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          {filteredCalls.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center py-12">
                <Phone className="h-10 w-10 text-muted-foreground mb-3" />
                <p className="font-medium">No calls recorded yet</p>
                <p className="text-sm text-muted-foreground">Calls will appear here once the voice system is active</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {filteredCalls.map(call => {
                const statusCfg = callStatusConfig[call.status] || callStatusConfig.completed
                const StatusIcon = statusCfg.icon
                const outcomeCfg = call.outcome ? outcomeConfig[call.outcome] : null

                return (
                  <Card
                    key={call.id}
                    className="group hover:border-primary/30 transition-colors cursor-pointer"
                    onClick={() => setSelectedCall(call)}
                  >
                    <CardContent className="py-3.5 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {/* Direction indicator */}
                        <div className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ${
                          call.status === 'in_progress'
                            ? 'bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/20'
                            : call.direction === 'inbound'
                              ? 'bg-blue-100 dark:bg-blue-900/30'
                              : 'bg-purple-100 dark:bg-purple-900/30'
                        }`}>
                          {call.status === 'in_progress' ? (
                            <Radio className="h-4.5 w-4.5 text-white animate-pulse" />
                          ) : call.direction === 'inbound' ? (
                            <PhoneCall className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                          ) : (
                            <Phone className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                          )}
                        </div>

                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-medium text-sm">
                              {call.lead
                                ? `${call.lead.first_name} ${call.lead.last_name || ''}`.trim()
                                : call.direction === 'inbound' ? maskPhone(call.from_number) : maskPhone(call.to_number)}
                            </p>
                            <Badge className={statusCfg.color + ' text-[11px] px-1.5 py-0'}>
                              <StatusIcon className="h-3 w-3 mr-0.5" />
                              {statusCfg.label}
                            </Badge>
                            {outcomeCfg && (
                              <Badge className={outcomeCfg.color + ' text-[11px] px-1.5 py-0'}>
                                {outcomeCfg.label}
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                            <span className="flex items-center gap-1">
                              {call.direction === 'inbound' ? '← Inbound' : '→ Outbound'}
                            </span>
                            <span>•</span>
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {formatDuration(call.duration_seconds)}
                            </span>
                            {call.agent_type && (
                              <>
                                <span>•</span>
                                <span className="capitalize">{call.agent_type} Agent</span>
                              </>
                            )}
                            <span>•</span>
                            <span>{formatDate(call.created_at)}</span>
                          </div>
                        </div>
                      </div>

                      {/* Transcript indicator */}
                      {call.transcript_summary && (
                        <div className="hidden md:flex items-center gap-1.5 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                          <FileText className="h-3.5 w-3.5" />
                          View Transcript
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </TabsContent>

        {/* ── Campaigns Tab ──────────────────────────────── */}
        <TabsContent value="campaigns" className="mt-4 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Automated outbound calling campaigns with AI agents
            </p>
            <NewCampaignDialog onCreated={() => router.refresh()} />
          </div>

          {campaigns.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center py-12">
                <Mic className="h-10 w-10 text-muted-foreground mb-3" />
                <p className="font-medium">No voice campaigns yet</p>
                <p className="text-sm text-muted-foreground">Create a campaign to start auto-dialing leads with AI</p>
              </CardContent>
            </Card>
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
                  <Card key={campaign.id} className="overflow-hidden">
                    <CardContent className="pt-5">
                      {/* Header */}
                      <div className="flex items-start justify-between mb-4">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="font-semibold">{campaign.name}</h3>
                            <Badge className={campaignStatusColors[campaign.status]}>
                              {campaign.status}
                            </Badge>
                          </div>
                          {campaign.description && (
                            <p className="text-xs text-muted-foreground">{campaign.description}</p>
                          )}
                        </div>
                        <Badge variant="outline" className="text-xs capitalize">
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
                        <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                          <span>Progress</span>
                          <span>{campaign.total_leads > 0 ? Math.round(campaign.total_called / campaign.total_leads * 100) : 0}%</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 transition-all duration-500"
                            style={{ width: `${campaign.total_leads > 0 ? Math.min(100, campaign.total_called / campaign.total_leads * 100) : 0}%` }}
                          />
                        </div>
                      </div>

                      {/* Rates */}
                      <div className="flex items-center gap-4 text-xs text-muted-foreground mb-4">
                        <span className="flex items-center gap-1">
                          <TrendingUp className="h-3 w-3" />
                          {connectRate}% connect
                        </span>
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {appointmentRate}% book
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatDuration(campaign.avg_call_duration_seconds)} avg
                        </span>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-2">
                        {(campaign.status === 'draft' || campaign.status === 'paused') && (
                          <Button
                            size="sm"
                            className="gap-1.5 flex-1 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white shadow-sm"
                            onClick={() => toggleCampaign(campaign.id, 'start')}
                            disabled={campaignAction === campaign.id}
                          >
                            {campaignAction === campaign.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
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
                            {campaignAction === campaign.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />}
                            Pause
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="gap-1">
                          <BarChart3 className="h-4 w-4" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* ── Call Detail Modal ─────────────────────────────── */}
      {selectedCall && (
        <CallDetailModal
          call={selectedCall}
          onClose={() => setSelectedCall(null)}
        />
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// STAT CARD
// ═══════════════════════════════════════════════════════════════

function StatCard({
  label,
  value,
  icon: Icon,
  gradient,
  shadowColor,
  subtext,
  pulse,
}: {
  label: string
  value: number
  icon: React.ElementType
  gradient: string
  shadowColor: string
  subtext?: string
  pulse?: boolean
}) {
  return (
    <Card className={`overflow-hidden ${shadowColor}`}>
      <CardContent className="pt-4 pb-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <div className={`h-8 w-8 rounded-lg bg-gradient-to-br ${gradient} flex items-center justify-center shadow-sm`}>
            <Icon className={`h-4 w-4 text-white ${pulse ? 'animate-pulse' : ''}`} />
          </div>
        </div>
        <p className="text-2xl font-bold">{value}</p>
        {subtext && <p className="text-xs text-muted-foreground mt-0.5">{subtext}</p>}
      </CardContent>
    </Card>
  )
}

// ═══════════════════════════════════════════════════════════════
// MINI STAT (for campaign cards)
// ═══════════════════════════════════════════════════════════════

function MiniStat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className="text-center">
      <p className={`text-lg font-bold ${highlight ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>{value}</p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// CALL DETAIL MODAL
// ═══════════════════════════════════════════════════════════════

function CallDetailModal({ call, onClose }: { call: VoiceCallRow; onClose: () => void }) {
  const statusCfg = callStatusConfig[call.status] || callStatusConfig.completed
  const outcomeCfg = call.outcome ? outcomeConfig[call.outcome] : null

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Phone className="h-4 w-4" />
            Call Details
          </DialogTitle>
          <DialogDescription>
            {call.direction === 'inbound' ? 'Inbound' : 'Outbound'} call •{' '}
            {formatDate(call.created_at)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Lead info */}
          {call.lead && (
            <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
              <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                <Users className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="font-medium text-sm">
                  {call.lead.first_name} {call.lead.last_name || ''}
                </p>
                <p className="text-xs text-muted-foreground capitalize">
                  {call.lead.status?.replace(/_/g, ' ')} • {call.lead.ai_qualification || 'unscored'}
                </p>
              </div>
            </div>
          )}

          {/* Status & Outcome */}
          <div className="flex items-center gap-2 flex-wrap">
            <Badge className={statusCfg.color}>{statusCfg.label}</Badge>
            {outcomeCfg && <Badge className={outcomeCfg.color}>{outcomeCfg.label}</Badge>}
            {call.agent_type && (
              <Badge variant="outline" className="capitalize">{call.agent_type} Agent</Badge>
            )}
          </div>

          {/* Call metrics */}
          <div className="grid grid-cols-3 gap-3">
            <div className="text-center p-2 rounded-lg bg-muted/50">
              <p className="text-xs text-muted-foreground">Duration</p>
              <p className="text-sm font-bold">{formatDuration(call.duration_seconds)}</p>
            </div>
            <div className="text-center p-2 rounded-lg bg-muted/50">
              <p className="text-xs text-muted-foreground">Direction</p>
              <p className="text-sm font-bold capitalize">{call.direction}</p>
            </div>
            <div className="text-center p-2 rounded-lg bg-muted/50">
              <p className="text-xs text-muted-foreground">Number</p>
              <p className="text-sm font-bold">{call.direction === 'inbound' ? maskPhone(call.from_number) : maskPhone(call.to_number)}</p>
            </div>
          </div>

          {/* Transcript summary */}
          {call.transcript_summary && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1">
                <FileText className="h-3 w-3" /> Call Summary
              </p>
              <p className="text-sm bg-muted/50 rounded-lg p-3 leading-relaxed">
                {call.transcript_summary}
              </p>
            </div>
          )}
        </div>

        <DialogFooter showCloseButton>
          {call.lead && (
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => {
              onClose()
              window.location.href = `/leads?id=${call.lead!.id}`
            }}>
              <Users className="h-3.5 w-3.5" />
              View Lead
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
        <Button size="sm" className="gap-1.5 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white shadow-sm">
          <Plus className="h-4 w-4" /> New Campaign
        </Button>
      } />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mic className="h-4 w-4" /> New Voice Campaign
          </DialogTitle>
          <DialogDescription>
            Create an outbound calling campaign. Your AI agent will automatically dial leads and engage them in conversation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Campaign Name</label>
            <Input
              placeholder="e.g., Q1 Reactivation Calls"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Description (optional)</label>
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
            className="gap-1.5 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
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
