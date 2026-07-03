'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow, format } from 'date-fns'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { LeadMessaging } from './lead-messaging'
import { LeadTimeline } from './lead-timeline'
import { LeadIntelligencePanel } from './lead-intelligence-panel'
import { ScheduleAppointment } from './schedule-appointment'
// LeadFinancingCard import removed pending live integrations
import { PatientSummaryCard } from './patient-summary-card'
import { LeadAIOverrideToggle } from './ai-mode-toggle'
import { TagBadge } from './tag-badge'
import { channelLabel } from '@/lib/attribution'
import { TagSelector } from './tag-selector'
import { PersonalityProfileCard } from './personality-profile-card'
import {
  ArrowLeft,
  Brain,
  Phone,
  Mail,
  MapPin,
  Calendar,
  DollarSign,
  MessageSquare,
  Activity,
  RefreshCw,
  Loader2,
  Tags,
} from 'lucide-react'
import type { Lead, PipelineStage, LeadActivity, Conversation, UserProfile, Tag, PatientProfile, ConversationAnalysis } from '@/types/database'
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

export function LeadDetail({
  lead: initialLead,
  activities,
  conversations,
  timeline,
  patientProfile,
  latestAnalysis,
  analyzableConversationId,
  stages,
  teamMembers,
}: {
  lead: Lead
  activities: LeadActivity[]
  conversations: Conversation[]
  timeline: TimelineEntry[]
  patientProfile: PatientProfile | null
  latestAnalysis: ConversationAnalysis | null
  analyzableConversationId: string | null
  stages: PipelineStage[]
  teamMembers: Pick<UserProfile, 'id' | 'full_name' | 'email' | 'role'>[]
}) {
  const [lead, setLead] = useState(initialLead)
  const [scoring, setScoring] = useState(false)
  const [leadTags, setLeadTags] = useState<Tag[]>([])
  const router = useRouter()

  // Fetch lead tags
  useEffect(() => {
    async function fetchTags() {
      try {
        const res = await fetch(`/api/leads/${lead.id}/tags`, { method: 'GET' })
        // The GET isn't implemented, but we handle gracefully
      } catch { /* ignore */ }

      // Fetch via lead_tags join
      try {
        const res = await fetch(`/api/tags`)
        if (res.ok) {
          // We'll populate from add/remove operations
        }
      } catch { /* ignore */ }
    }
    // Tags will be populated when user interacts
  }, [lead.id])

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
    <div className="animate-in fade-in-0 duration-500 space-y-6">
      {/* ── Header ─────────────────────────────────────── */}
      <header className="border-b border-aurea-border pb-6">
        <div className="mb-4 flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => router.back()}>
            <ArrowLeft className="h-[15px] w-[15px]" strokeWidth={1.75} />
          </Button>
          <p className="aurea-eyebrow">Lead Detail</p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Avatar className="h-12 w-12 shrink-0">
            <AvatarFallback className="text-[15px] font-semibold">{initials}</AvatarFallback>
          </Avatar>
          <div className="flex-1">
            <h1 className="aurea-display text-[32px] text-aurea-ink sm:text-[40px]">
              {lead.first_name} {lead.last_name}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-4 text-[13px] text-aurea-ink-3">
              {lead.phone && (
                <span className="flex items-center gap-1.5">
                  <Phone className="h-[13px] w-[13px]" strokeWidth={1.75} />
                  <span className="font-mono">{lead.phone}</span>
                </span>
              )}
              {lead.email && (
                <span className="flex items-center gap-1.5">
                  <Mail className="h-[13px] w-[13px]" strokeWidth={1.75} />
                  {lead.email}
                </span>
              )}
              {lead.city && (
                <span className="flex items-center gap-1.5">
                  <MapPin className="h-[13px] w-[13px]" strokeWidth={1.75} />
                  {lead.city}, {lead.state}
                </span>
              )}
            </div>
          </div>

          {/* AI Engagement Score */}
          <div className="flex flex-col items-center gap-1">
            <span className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[15px] font-semibold ${qualificationColors[lead.ai_qualification]}`}>
              <Brain className="h-[15px] w-[15px]" strokeWidth={1.75} />
              <span className="font-mono tabular-nums">{lead.ai_score}/100</span>
            </span>
            <p className="aurea-eyebrow capitalize">{lead.ai_qualification}</p>
          </div>

          <LeadMessaging lead={lead} />
          <ScheduleAppointment lead={lead} />

          <Button onClick={scoreLead} disabled={scoring} variant="outline" size="sm" className="gap-1.5">
            {scoring
              ? <Loader2 className="h-[15px] w-[15px] animate-spin" strokeWidth={1.75} />
              : <RefreshCw className="h-[15px] w-[15px]" strokeWidth={1.75} />}
            {scoring ? 'Scoring…' : 'Re-score'}
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-3 gap-6">
        {/* ── Left Column — Details ──────────────────────── */}
        <div className="col-span-2 space-y-6">
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="channel">Channel</TabsTrigger>
              <TabsTrigger value="conversations">
                Conversations ({conversations.length})
              </TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="mt-4 space-y-4">
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
            </TabsContent>

            <TabsContent value="channel" className="mt-4 space-y-4">
              <LeadIntelligencePanel
                lead={lead}
                profile={patientProfile}
                analysis={latestAnalysis}
                analyzableConversationId={analyzableConversationId}
              />
              <LeadTimeline lead={lead} entries={timeline} />
            </TabsContent>

            <TabsContent value="conversations" className="mt-4">
              {conversations.length === 0 ? (
                <div className="aurea-card flex flex-col items-center py-12">
                  <MessageSquare className="mb-3 h-10 w-10 text-aurea-ink-3" strokeWidth={1.75} />
                  <p className="text-[14px] font-medium text-aurea-ink">No conversations yet</p>
                  <p className="mt-1 text-[13px] text-aurea-ink-3">
                    Start a conversation via SMS or email
                  </p>
                </div>
              ) : (
                <div className="aurea-card overflow-hidden">
                  {conversations.map((convo, i) => (
                    <div
                      key={convo.id}
                      className={`cursor-pointer px-5 py-3.5 transition-colors hover:bg-aurea-surface-2 ${i < conversations.length - 1 ? 'border-b border-aurea-border' : ''}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="rounded border border-aurea-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-aurea-ink-3">
                            {convo.channel}
                          </span>
                          <span className="text-[14px] font-medium text-aurea-ink">
                            {convo.subject || `${convo.channel.toUpperCase()} Conversation`}
                          </span>
                        </div>
                        <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3">
                          {convo.last_message_at
                            ? formatDistanceToNow(new Date(convo.last_message_at), { addSuffix: true })
                            : ''}
                        </span>
                      </div>
                      {convo.last_message_preview && (
                        <p className="mt-1 truncate text-[12px] text-aurea-ink-3">
                          {convo.last_message_preview}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="activity" className="mt-4">
              <div className="aurea-card overflow-hidden">
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
            </TabsContent>
          </Tabs>
        </div>

        {/* ── Right Column — Actions & Status ───────────── */}
        <div className="space-y-4">
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
                  // Find newly added tag IDs
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
              <Select
                value={lead.stage_id || ''}
                onValueChange={(v) => updateLead({ stage_id: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select stage" />
                </SelectTrigger>
                <SelectContent>
                  {stages.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: s.color }} />
                        {s.name}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                <SelectTrigger>
                  <SelectValue placeholder="Unassigned" />
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
            <div className="border-b border-aurea-border px-5 py-4">
              <h2 className="aurea-display text-[18px] text-aurea-ink">Engagement</h2>
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

          {/* Financing panel temporarily removed until live integrations are available */}

          {/* Source */}
          <div className="aurea-card overflow-hidden">
            <div className="border-b border-aurea-border px-5 py-4">
              <h2 className="aurea-display text-[18px] text-aurea-ink">Source</h2>
            </div>
            <div className="px-5">
              {[
                { label: 'Type', value: lead.source_type?.replace(/_/g, ' ') || '—', capitalize: true },
                ...(channelLabel(lead.campaign_attribution?.channel)
                  ? [{ label: 'Channel', value: channelLabel(lead.campaign_attribution?.channel)!, capitalize: false }]
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
              ].map((item) => (
                <div key={item.label} className="flex items-center justify-between border-b border-aurea-border py-3 last:border-0">
                  <span className="text-[13px] text-aurea-ink-3">{item.label}</span>
                  <span className={`font-mono text-[12px] text-aurea-ink ${item.capitalize ? 'capitalize' : ''}`}>
                    {item.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
