'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow, format } from 'date-fns'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { LeadActions } from './lead-actions'
import { EngagementMeter } from './engagement-meter'
import { TimelineFeed } from './lead-timeline'
import { ConversationThread } from './conversation-thread'
import type { LeadNote } from './lead-notes-panel'
import { StageSelect } from './stage-select'
import { LeadIntelligencePanel } from './lead-intelligence-panel'
import { ScheduleAppointment } from './schedule-appointment'
// LeadFinancingCard import removed pending live integrations
import { PatientSummaryCard } from './patient-summary-card'
import { LeadAIOverrideToggle } from './ai-mode-toggle'
import { TagBadge } from './tag-badge'
import { channelLabel, displaySourceLabel } from '@/lib/attribution'
import { TagSelector } from './tag-selector'
import { PersonalityProfileCard } from './personality-profile-card'
import { AuditTimeline } from '@/components/audit/AuditTimeline'
import {
  ArrowLeft,
  Brain,
  Phone,
  Mail,
  MapPin,
  RefreshCw,
  Loader2,
  Tags,
  MessagesSquare,
  GitBranch,
  PanelRightClose,
  PanelRightOpen,
  ChevronDown,
} from 'lucide-react'
import type { Lead, PipelineStage, LeadActivity, Conversation, Message, VoiceCall, UserProfile, Tag, PatientProfile, ConversationAnalysis } from '@/types/database'
import type { TimelineEntry } from '@/lib/timeline/types'
import { toast } from 'sonner'

// Lead qualification chips — hot=rose, warm=amber, cold=neutral
const qualificationColors: Record<string, string> = {
  hot: 'bg-aurea-rose/10 text-aurea-rose border border-aurea-rose/20',
  warm: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20',
  cold: 'bg-aurea-surface-2 text-aurea-ink-2 border border-aurea-border',
  unqualified: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border',
  unscored: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border',
}

// Per-browser memory for the Details side panel: once opened, it stays open on
// every lead the user visits (see the sync effects in LeadDetail).
const DETAILS_PREF_KEY = 'lead-detail:details-open'

export function LeadDetail({
  lead: initialLead,
  activities,
  conversations,
  primaryConversation,
  threadMessages,
  threadCalls,
  timeline,
  patientProfile,
  latestAnalysis,
  analyzableConversationId,
  stages,
  teamMembers,
  initialTags = [],
  prequalEnabled = false,
  noShowFeeEnabled = false,
  timeZone,
  canTrainAi = false,
  notes = [],
  currentUserId = null,
}: {
  lead: Lead
  activities: LeadActivity[]
  conversations: Conversation[]
  primaryConversation: Conversation | null
  threadMessages: Message[]
  threadCalls: VoiceCall[]
  timeline: TimelineEntry[]
  patientProfile: PatientProfile | null
  latestAnalysis: ConversationAnalysis | null
  analyzableConversationId: string | null
  stages: PipelineStage[]
  teamMembers: Pick<UserProfile, 'id' | 'full_name' | 'email' | 'role'>[]
  /** Lead's tags, fetched server-side via the lead_tags join. */
  initialTags?: Tag[]
  prequalEnabled?: boolean
  noShowFeeEnabled?: boolean
  /** Practice IANA timezone, forwarded so thread timestamps render zone-fixed. */
  timeZone?: string
  /** Admin roles only (computed server-side): shows the per-call "Use for AI
   *  training" control, forwarded to the thread's call cards. */
  canTrainAi?: boolean
  /** Manual team notes for this lead, forwarded to the thread's Notes panel. */
  notes?: LeadNote[]
  /** Viewer's user id — notes expose edit/delete only on the author's own rows. */
  currentUserId?: string | null
}) {
  const [lead, setLead] = useState(initialLead)
  const [scoring, setScoring] = useState(false)
  const [leadTags, setLeadTags] = useState<Tag[]>(initialTags)
  // Conversation-first surface: the chat is the hero; the lead's features live
  // in a collapsible Details panel on the same page (closed by default).
  const [mode, setMode] = useState<'thread' | 'timeline'>('thread')
  // Details panel starts closed to avoid a hydration mismatch (localStorage is
  // browser-only), then we sync to the user's remembered preference on mount.
  const [showDetails, setShowDetails] = useState(false)
  // Activity + audit trail start collapsed so the rail stays scannable at a glance.
  const [showActivity, setShowActivity] = useState(false)
  const [showAudit, setShowAudit] = useState(false)
  const router = useRouter()

  // Remember whether the Details panel is open across leads: once the user opens
  // it, it stays open on every lead they visit (and vice-versa), scoped per-browser.
  useEffect(() => {
    if (localStorage.getItem(DETAILS_PREF_KEY) === 'open') setShowDetails(true)
  }, [])

  useEffect(() => {
    localStorage.setItem(DETAILS_PREF_KEY, showDetails ? 'open' : 'closed')
  }, [showDetails])

  async function addTags(tagIds: string[]) {
    const res = await fetch(`/api/leads/${lead.id}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_ids: tagIds }),
    })
    if (res.ok) {
      const { lead_tags } = await res.json()
      setLeadTags(lead_tags.map((lt: any) => lt.tag).filter(Boolean))
      toast.success('Tags updated')
    } else {
      toast.error('Failed to update tags')
    }
  }

  async function removeTag(tagId: string) {
    const res = await fetch(`/api/leads/${lead.id}/tags`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_ids: [tagId] }),
    })
    if (res.ok) {
      const { lead_tags } = await res.json()
      setLeadTags(lead_tags.map((lt: any) => lt.tag).filter(Boolean))
      toast.success('Tag removed')
    } else {
      toast.error('Failed to remove tag')
    }
  }

  const initials = `${lead.first_name?.[0] || ''}${lead.last_name?.[0] || ''}`.toUpperCase()

  async function updateLead(updates: Record<string, unknown>) {
    const res = await fetch(`/api/leads/${lead.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    if (res.ok) {
      const { lead: updated } = await res.json()
      setLead({ ...lead, ...updated })
      router.refresh()
      toast.success('Lead updated')
    } else {
      toast.error('Failed to update lead')
    }
  }

  async function scoreLead() {
    setScoring(true)
    try {
      const res = await fetch(`/api/leads/${lead.id}/score`, { method: 'POST' })
      if (res.ok) {
        const { score } = await res.json()
        setLead({
          ...lead,
          ai_score: score.total_score,
          ai_qualification: score.qualification,
          ai_summary: score.summary,
          ai_score_breakdown: { dimensions: score.dimensions },
        })
        toast.success(`Lead scored: ${score.total_score}/100 (${score.qualification})`)
        router.refresh()
      } else {
        toast.error('Failed to score lead')
      }
    } finally {
      setScoring(false)
    }
  }

  const scoreBreakdown = (lead.ai_score_breakdown as any)?.dimensions || []

  return (
    <div className="flex h-full min-h-0 animate-in fade-in-0 duration-500">
      {/* ── Conversation (hero) — the same chat window as /conversations ── */}
      <section className="flex min-w-0 flex-1 flex-col">
        {/* Top strip — Thread ⇄ Timeline + the Details toggle. When there's no
            thread yet, the strip also carries the back-arrow + lead identity so
            the surface still has a header. */}
        <div className="flex items-center justify-between gap-2 border-b border-aurea-border px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            {/* Timeline mode has no thread header of its own, so the strip carries
                the back-arrow + identity there. In Thread mode the embedded
                ConversationThread renders its own header instead. */}
            {mode === 'timeline' && (
              <>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => router.push('/leads')}>
                  <ArrowLeft className="h-[15px] w-[15px]" strokeWidth={1.75} />
                </Button>
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-aurea-border bg-aurea-surface-2">
                  <span className="aurea-display text-[13px] text-aurea-ink-2">{initials || '?'}</span>
                </div>
                <span className="aurea-display truncate text-[18px] text-aurea-ink">
                  {lead.first_name} {lead.last_name}
                </span>
              </>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <div className="inline-flex items-center rounded-full border border-aurea-border bg-aurea-surface p-0.5 text-[12px]">
              <ModeButton active={mode === 'thread'} onClick={() => setMode('thread')} icon={<MessagesSquare className="h-3.5 w-3.5" strokeWidth={1.75} />} label="Thread" />
              <ModeButton active={mode === 'timeline'} onClick={() => setMode('timeline')} icon={<GitBranch className="h-3.5 w-3.5" strokeWidth={1.75} />} label="Timeline" />
            </div>
            {/* Ghost when closed: as an outline button it visually outranked the
                Thread/Timeline toggle beside it, which is the control staff
                actually need to find. */}
            <Button
              variant={showDetails ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setShowDetails((v) => !v)}
              aria-pressed={showDetails}
              className="gap-1.5"
            >
              {showDetails
                ? <PanelRightClose className="h-3.5 w-3.5" strokeWidth={1.75} />
                : <PanelRightOpen className="h-3.5 w-3.5" strokeWidth={1.75} />}
              Details
            </Button>
          </div>
        </div>

        {/* Body — the chat thread (the same messenger as /conversations, with
            Text/Email/Call in one composer) or its condensed timeline. The
            thread renders even before a conversation exists: the first send
            find-or-creates it server-side, then the surface refreshes. */}
        <div className="min-h-0 flex-1">
          {mode === 'thread' ? (
            <ConversationThread
              lead={lead}
              stages={stages}
              conversation={primaryConversation}
              messages={threadMessages}
              calls={threadCalls}
              prequalEnabled={prequalEnabled}
              noShowFeeEnabled={noShowFeeEnabled}
              backHref="/leads"
              savedAnalysis={latestAnalysis}
              patientProfile={patientProfile}
              timeZone={timeZone}
              canTrainAi={canTrainAi}
              notes={notes}
              currentUserId={currentUserId}
            />
          ) : (
            <div className="h-full overflow-y-auto px-5 py-6">
              {timeline.length === 0 ? (
                <p className="py-16 text-center text-sm text-aurea-ink-3">No calls, texts, or emails yet.</p>
              ) : (
                <div className="mx-auto max-w-[680px]">
                  <TimelineFeed entries={timeline} timeZone={timeZone} />
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* ── Details panel (collapsible) — every lead feature, one page ──── */}
      {showDetails && (
        <aside className="w-[380px] shrink-0 overflow-y-auto border-l border-aurea-border bg-aurea-canvas">
          <div className="space-y-4 p-4">
            {/* Identity + primary actions */}
            <div className="space-y-3 border-b border-aurea-border pb-4">
              <div className="flex items-center gap-3">
                <Avatar className="h-11 w-11 shrink-0">
                  <AvatarFallback className="text-[14px] font-semibold">{initials}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <h2 className="aurea-display truncate text-[20px] text-aurea-ink">
                    {lead.first_name} {lead.last_name}
                  </h2>
                  <span className={`mt-1 inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[12px] font-semibold ${qualificationColors[lead.ai_qualification]}`}>
                    <Brain className="h-3 w-3" strokeWidth={1.75} />
                    <span className="font-mono tabular-nums">{lead.ai_score}/100</span>
                    <span className="capitalize">· {lead.ai_qualification}</span>
                  </span>
                </div>
              </div>

              <div className="space-y-1.5 text-[13px] text-aurea-ink-3">
                {lead.phone && (
                  <span className="flex items-center gap-1.5">
                    <Phone className="h-[13px] w-[13px]" strokeWidth={1.75} />
                    <span className="font-mono">{lead.phone}</span>
                  </span>
                )}
                {lead.email && (
                  <span className="flex items-center gap-1.5">
                    <Mail className="h-[13px] w-[13px]" strokeWidth={1.75} />
                    <span className="truncate">{lead.email}</span>
                  </span>
                )}
                {lead.city && (
                  <span className="flex items-center gap-1.5">
                    <MapPin className="h-[13px] w-[13px]" strokeWidth={1.75} />
                    {lead.city}, {lead.state}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <LeadActions lead={lead} variant="bar" prequalEnabled={prequalEnabled} noShowFeeEnabled={noShowFeeEnabled} />
                <ScheduleAppointment lead={lead} />
                <Button onClick={scoreLead} disabled={scoring} variant="outline" size="sm" className="gap-1.5">
                  {scoring
                    ? <Loader2 className="h-[15px] w-[15px] animate-spin" strokeWidth={1.75} />
                    : <RefreshCw className="h-[15px] w-[15px]" strokeWidth={1.75} />}
                  {scoring ? 'Scoring…' : 'Re-score'}
                </Button>
              </div>
            </div>

            {/* Other threads — quick links when the patient has more than one
                channel conversation. */}
            {primaryConversation && conversations.length > 1 && (
              <div className="aurea-card flex flex-wrap items-center gap-2 px-4 py-3">
                <span className="aurea-eyebrow mr-1">Threads</span>
                {conversations.map((convo) => {
                  const active = convo.id === primaryConversation.id
                  return (
                    <Link
                      key={convo.id}
                      href={`/conversations/${convo.id}`}
                      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-mono uppercase tracking-wide transition-colors ${
                        active
                          ? 'border-aurea-primary/30 bg-aurea-primary/10 text-aurea-primary'
                          : 'border-aurea-border text-aurea-ink-3 hover:bg-aurea-surface-2 hover:text-aurea-ink'
                      }`}
                    >
                      {convo.channel}
                      {convo.last_message_at && (
                        <span className="normal-case text-aurea-ink-3">
                          · {formatDistanceToNow(new Date(convo.last_message_at), { addSuffix: true })}
                        </span>
                      )}
                    </Link>
                  )
                })}
              </div>
            )}

            {/* AI Summary */}
            {lead.ai_summary && (
              <div className="aurea-card overflow-hidden">
                <div className="flex items-center gap-2 border-b border-aurea-border px-5 py-4">
                  <Brain className="h-[15px] w-[15px] text-aurea-primary" strokeWidth={1.75} />
                  <h2 className="aurea-display text-[18px] text-aurea-ink">AI Summary</h2>
                </div>
                <div className="px-5 py-4">
                  <p className="text-[14px] leading-relaxed text-aurea-ink-2">{lead.ai_summary}</p>
                </div>
              </div>
            )}

            {/* Score Breakdown */}
            {scoreBreakdown.length > 0 && (
              <div className="aurea-card overflow-hidden">
                <div className="border-b border-aurea-border px-5 py-4">
                  <h2 className="aurea-display text-[18px] text-aurea-ink">Score Breakdown</h2>
                </div>
                <div className="space-y-4 px-5 py-4">
                  {scoreBreakdown.map((dim: any) => (
                    <div key={dim.name}>
                      <div className="flex items-center justify-between text-[13px]">
                        <span className="capitalize text-aurea-ink-2">{dim.name.replace(/_/g, ' ')}</span>
                        <span className="font-mono tabular-nums text-aurea-ink">{dim.score}/100</span>
                      </div>
                      <div className="mt-1.5 h-[3px] w-full overflow-hidden rounded-full bg-aurea-surface-2">
                        <div
                          className="h-full rounded-full bg-aurea-primary transition-all"
                          style={{ width: `${dim.score}%` }}
                        />
                      </div>
                      <p className="mt-1 text-[11.5px] text-aurea-ink-3">{dim.reasoning}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Dental Info */}
            <div className="aurea-card overflow-hidden">
              <div className="border-b border-aurea-border px-5 py-4">
                <h2 className="aurea-display text-[18px] text-aurea-ink">Dental Information</h2>
              </div>
              <div className="grid grid-cols-2 gap-px bg-aurea-border">
                {[
                  { label: 'Condition', value: lead.dental_condition?.replace(/_/g, ' ') || '—', mono: false },
                  { label: 'Has Dentures', value: lead.has_dentures === true ? 'Yes' : lead.has_dentures === false ? 'No' : '—', mono: false },
                  { label: 'Insurance', value: lead.has_dental_insurance ? lead.insurance_provider || 'Yes' : 'No', mono: false },
                  { label: 'Financing Interest', value: lead.financing_interest?.replace(/_/g, ' ') || '—', mono: false },
                ].map((item) => (
                  <div key={item.label} className="bg-aurea-surface px-5 py-3.5">
                    <p className="aurea-eyebrow mb-1">{item.label}</p>
                    <p className="text-[14px] capitalize text-aurea-ink">{item.value}</p>
                  </div>
                ))}
                {lead.dental_condition_details && (
                  <div className="col-span-2 bg-aurea-surface px-5 py-3.5">
                    <p className="aurea-eyebrow mb-1">Details</p>
                    <p className="text-[14px] text-aurea-ink-2">{lead.dental_condition_details}</p>
                  </div>
                )}
              </div>
            </div>

            {/* Channel intelligence */}
            <LeadIntelligencePanel
              lead={lead}
              profile={patientProfile}
              analysis={latestAnalysis}
              analyzableConversationId={analyzableConversationId}
            />

            {/* Tags */}
            <div className="aurea-card overflow-hidden">
              <div className="flex items-center gap-2 border-b border-aurea-border px-5 py-4">
                <Tags className="h-[15px] w-[15px] text-aurea-ink-3" strokeWidth={1.75} />
                <h2 className="aurea-display text-[18px] text-aurea-ink">Tags</h2>
              </div>
              <div className="space-y-3 px-5 py-4">
                {leadTags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {leadTags.map((tag) => (
                      <TagBadge key={tag.id} tag={tag} onRemove={() => removeTag(tag.id)} />
                    ))}
                  </div>
                )}
                <TagSelector
                  selectedTagIds={leadTags.map((t) => t.id)}
                  onTagsChange={(ids) => {
                    const current = new Set(leadTags.map((t) => t.id))
                    const toAdd = ids.filter((id) => !current.has(id))
                    const toRemove = [...current].filter((id) => !ids.includes(id))
                    if (toAdd.length > 0) addTags(toAdd)
                    if (toRemove.length > 0) toRemove.forEach(removeTag)
                  }}
                  className="w-full"
                  placeholder="Add tags..."
                />
              </div>
            </div>

            {/* Patient AI Summary */}
            <PatientSummaryCard leadId={lead.id} lead={lead} />

            {/* Personality Profile */}
            <PersonalityProfileCard
              leadId={lead.id}
              initialProfile={lead.personality_profile as any}
            />

            {/* AI Autopilot Control */}
            <div className="aurea-card overflow-hidden">
              <div className="flex items-center gap-2 border-b border-aurea-border px-5 py-4">
                <Brain className="h-[15px] w-[15px] text-aurea-primary" strokeWidth={1.75} />
                <h2 className="aurea-display text-[18px] text-aurea-ink">AI Autopilot</h2>
              </div>
              <div className="px-5 py-4">
                <LeadAIOverrideToggle
                  leadId={lead.id}
                  currentOverride={(lead.ai_autopilot_override as any) || 'default'}
                />
              </div>
            </div>

            {/* Pipeline Stage */}
            <div className="aurea-card overflow-hidden">
              <div className="border-b border-aurea-border px-5 py-4">
                <h2 className="aurea-display text-[18px] text-aurea-ink">Pipeline Stage</h2>
              </div>
              <div className="px-5 py-4">
                <StageSelect
                  stages={stages}
                  value={lead.stage_id}
                  onChange={(v) => updateLead({ stage_id: v })}
                />
              </div>
            </div>

            {/* Assigned To */}
            <div className="aurea-card overflow-hidden">
              <div className="border-b border-aurea-border px-5 py-4">
                <h2 className="aurea-display text-[18px] text-aurea-ink">Assigned To</h2>
              </div>
              <div className="px-5 py-4">
                <Select
                  value={lead.assigned_to || 'unassigned'}
                  onValueChange={(v) => updateLead({ assigned_to: v === 'unassigned' ? null : v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Unassigned">
                      {(value) => teamMembers.find((m) => m.id === value)?.full_name ?? 'Unassigned'}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unassigned">Unassigned</SelectItem>
                    {teamMembers.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.full_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Engagement Stats */}
            <div className="aurea-card overflow-hidden">
              <div className="flex items-center justify-between border-b border-aurea-border px-5 py-4">
                <h2 className="aurea-display text-[18px] text-aurea-ink">Engagement</h2>
                {/* Behavioral temperature (engagement sweep) — recency-driven,
                    distinct from the AI score card above. */}
                <EngagementMeter
                  temperature={lead.engagement_temperature}
                  score={lead.engagement_score}
                />
              </div>
              <div className="px-5">
                {[
                  { label: 'Messages Sent', value: lead.total_messages_sent },
                  { label: 'Messages Received', value: lead.total_messages_received },
                  { label: 'Emails Sent', value: lead.total_emails_sent },
                ].map((item) => (
                  <div key={item.label} className="flex items-center justify-between border-b border-aurea-border py-3 last:border-0">
                    <span className="text-[13px] text-aurea-ink-3">{item.label}</span>
                    <span className="font-mono text-[13px] tabular-nums text-aurea-ink">{item.value}</span>
                  </div>
                ))}
                <div className="border-t border-aurea-border-strong py-3">
                  <div className="flex items-center justify-between border-b border-aurea-border py-2.5 last:border-0">
                    <span className="text-[13px] text-aurea-ink-3">Last Contact</span>
                    <span className="font-mono text-[12px] tabular-nums text-aurea-ink">
                      {lead.last_contacted_at
                        ? formatDistanceToNow(new Date(lead.last_contacted_at), { addSuffix: true })
                        : 'Never'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-2.5">
                    <span className="text-[13px] text-aurea-ink-3">Last Response</span>
                    <span className="font-mono text-[12px] tabular-nums text-aurea-ink">
                      {lead.last_responded_at
                        ? formatDistanceToNow(new Date(lead.last_responded_at), { addSuffix: true })
                        : 'Never'}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Source */}
            <div className="aurea-card overflow-hidden">
              <div className="border-b border-aurea-border px-5 py-4">
                <h2 className="aurea-display text-[18px] text-aurea-ink">Source</h2>
              </div>
              <div className="px-5">
                {(() => {
                  // "Type" shows where the lead actually came from — an
                  // aggregator/call-tracking label ("whatconverts", …) is
                  // resolved to the real channel. The separate "Channel" row is
                  // dropped when it would just repeat the resolved Type.
                  const resolvedSource =
                    displaySourceLabel(lead.source_type, lead.campaign_attribution?.channel)?.replace(/_/g, ' ') ||
                    '—'
                  const channel = channelLabel(lead.campaign_attribution?.channel)
                  return [
                  { label: 'Type', value: resolvedSource, capitalize: true },
                  ...(channel && channel !== resolvedSource
                    ? [{ label: 'Channel', value: channel, capitalize: false }]
                    : []),
                  // Exact campaign resolved by DGS wins over the raw UTM value.
                  ...(lead.campaign_attribution?.campaign_name || lead.utm_campaign
                    ? [{ label: 'Campaign', value: lead.campaign_attribution?.campaign_name || lead.utm_campaign!, capitalize: false }]
                    : []),
                  ...(lead.campaign_attribution?.ad_group_name
                    ? [{ label: 'Ad Group', value: lead.campaign_attribution.ad_group_name, capitalize: false }]
                    : []),
                  ...(lead.campaign_attribution?.keyword_text
                    ? [{ label: 'Keyword', value: lead.campaign_attribution.keyword_text, capitalize: false }]
                    : []),
                  ...(lead.utm_source ? [{ label: 'UTM Source', value: lead.utm_source, capitalize: false }] : []),
                  { label: 'Created', value: format(new Date(lead.created_at), 'MMM d, yyyy'), capitalize: false },
                  ]
                })().map((item) => (
                  <div key={item.label} className="flex items-center justify-between border-b border-aurea-border py-3 last:border-0">
                    <span className="text-[13px] text-aurea-ink-3">{item.label}</span>
                    <span className={`font-mono text-[12px] text-aurea-ink ${item.capitalize ? 'capitalize' : ''}`}>
                      {item.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Activity + full audit trail */}
            <div className="aurea-card overflow-hidden">
              <button
                type="button"
                onClick={() => setShowActivity((v) => !v)}
                aria-expanded={showActivity}
                className={`flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-aurea-surface-2 ${showActivity ? 'border-b border-aurea-border' : ''}`}
              >
                <span className="flex items-center gap-2">
                  <h2 className="aurea-display text-[18px] text-aurea-ink">Activity</h2>
                  {activities.length > 0 && (
                    <span className="rounded-full bg-aurea-surface-2 px-2 py-0.5 font-mono text-[11px] tabular-nums text-aurea-ink-3">
                      {activities.length}
                    </span>
                  )}
                </span>
                <ChevronDown
                  className={`h-4 w-4 shrink-0 text-aurea-ink-3 transition-transform ${showActivity ? '' : '-rotate-90'}`}
                />
              </button>
              {showActivity && (
                <div>
                  {activities.map((act, i) => (
                    <div
                      key={act.id}
                      className={`flex items-start gap-3 px-5 py-3.5 ${i < activities.length - 1 ? 'border-b border-aurea-border' : ''}`}
                    >
                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-aurea-ink-3" />
                      <div className="flex-1">
                        <p className="text-[14px] font-medium text-aurea-ink">{act.title}</p>
                        {act.description && (
                          <p className="mt-0.5 text-[12px] text-aurea-ink-3">{act.description}</p>
                        )}
                        <p className="mt-0.5 font-mono text-[11px] tabular-nums text-aurea-ink-3">
                          {format(new Date(act.created_at), 'MMM d, yyyy h:mm a')}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="aurea-card overflow-hidden">
              <button
                type="button"
                onClick={() => setShowAudit((v) => !v)}
                aria-expanded={showAudit}
                className={`flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-aurea-surface-2 ${showAudit ? 'border-b border-aurea-border' : ''}`}
              >
                <h3 className="aurea-display text-[16px] text-aurea-ink">Audit trail</h3>
                <ChevronDown
                  className={`h-4 w-4 shrink-0 text-aurea-ink-3 transition-transform ${showAudit ? '' : '-rotate-90'}`}
                />
              </button>
              {showAudit && (
                <div className="px-5 py-4">
                  <AuditTimeline query={`resourceType=leads&resourceId=${lead.id}`} />
                </div>
              )}
            </div>

            {/* Financing panel temporarily removed until live integrations are available */}
          </div>
        </aside>
      )}
    </div>
  )
}

function ModeButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      // Matches ConversationView's toggle: the inactive half sits at ink-2, not
      // the near-invisible ink-3, so Timeline reads as a control staff can click.
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-medium transition-colors ${
        active
          ? 'bg-aurea-ink text-aurea-canvas'
          : 'text-aurea-ink-2 hover:bg-aurea-surface-2 hover:text-aurea-ink'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}
