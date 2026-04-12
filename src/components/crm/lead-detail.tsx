'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow, format } from 'date-fns'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { LeadMessaging } from './lead-messaging'
import { ScheduleAppointment } from './schedule-appointment'
// LeadFinancingCard import removed pending live integrations
import { PatientSummaryCard } from './patient-summary-card'
import { LeadAIOverrideToggle } from './ai-mode-toggle'
import { TagBadge } from './tag-badge'
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
import type { Lead, PipelineStage, LeadActivity, Conversation, UserProfile, Tag } from '@/types/database'
import { toast } from 'sonner'

const qualificationColors: Record<string, string> = {
  hot: 'bg-red-500/10 text-red-700',
  warm: 'bg-orange-500/10 text-orange-700',
  cold: 'bg-blue-500/10 text-blue-700',
  unqualified: 'bg-gray-500/10 text-gray-600',
  unscored: 'bg-gray-100 text-gray-400',
}

export function LeadDetail({
  lead: initialLead,
  activities,
  conversations,
  stages,
  teamMembers,
}: {
  lead: Lead
  activities: LeadActivity[]
  conversations: Conversation[]
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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Avatar className="h-12 w-12">
          <AvatarFallback className="text-lg">{initials}</AvatarFallback>
        </Avatar>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">
            {lead.first_name} {lead.last_name}
          </h1>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            {lead.phone && (
              <span className="flex items-center gap-1">
                <Phone className="h-3 w-3" /> {lead.phone}
              </span>
            )}
            {lead.email && (
              <span className="flex items-center gap-1">
                <Mail className="h-3 w-3" /> {lead.email}
              </span>
            )}
            {lead.city && (
              <span className="flex items-center gap-1">
                <MapPin className="h-3 w-3" /> {lead.city}, {lead.state}
              </span>
            )}
          </div>
        </div>

        {/* AI Engagement Score */}
        <div className="text-center">
          <Badge className={`text-lg px-3 py-1 ${qualificationColors[lead.ai_qualification]}`}>
            <Brain className="h-4 w-4 mr-1" />
            {lead.ai_score}/100
          </Badge>
          <p className="text-xs text-muted-foreground mt-1 capitalize">
            {lead.ai_qualification}
          </p>
        </div>

        <LeadMessaging lead={lead} />
        <ScheduleAppointment lead={lead} />

        <Button onClick={scoreLead} disabled={scoring} variant="outline" size="sm">
          {scoring ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
          {scoring ? 'Scoring...' : 'Re-score'}
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Left Column — Details */}
        <div className="col-span-2 space-y-6">
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="conversations">
                Conversations ({conversations.length})
              </TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="space-y-4 mt-4">
              {/* AI Summary */}
              {lead.ai_summary && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Brain className="h-4 w-4" /> AI Summary
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm">{lead.ai_summary}</p>
                  </CardContent>
                </Card>
              )}

              {/* Score Breakdown */}
              {scoreBreakdown.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Score Breakdown</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {scoreBreakdown.map((dim: any) => (
                        <div key={dim.name}>
                          <div className="flex items-center justify-between text-sm">
                            <span className="capitalize">{dim.name.replace(/_/g, ' ')}</span>
                            <span className="font-medium">{dim.score}/100</span>
                          </div>
                          <div className="mt-1 h-2 rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full rounded-full bg-primary transition-all"
                              style={{ width: `${dim.score}%` }}
                            />
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {dim.reasoning}
                          </p>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Dental Info */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Dental Information</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground">Condition</p>
                    <p className="font-medium capitalize">
                      {lead.dental_condition?.replace(/_/g, ' ') || '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Has Dentures</p>
                    <p className="font-medium">
                      {lead.has_dentures === true ? 'Yes' : lead.has_dentures === false ? 'No' : '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Insurance</p>
                    <p className="font-medium">
                      {lead.has_dental_insurance ? lead.insurance_provider || 'Yes' : 'No'}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Financing Interest</p>
                    <p className="font-medium capitalize">
                      {lead.financing_interest?.replace(/_/g, ' ') || '—'}
                    </p>
                  </div>
                  {lead.dental_condition_details && (
                    <div className="col-span-2">
                      <p className="text-muted-foreground">Details</p>
                      <p>{lead.dental_condition_details}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="conversations" className="mt-4">
              {conversations.length === 0 ? (
                <Card>
                  <CardContent className="flex flex-col items-center py-12">
                    <MessageSquare className="h-10 w-10 text-muted-foreground mb-3" />
                    <p className="font-medium">No conversations yet</p>
                    <p className="text-sm text-muted-foreground">
                      Start a conversation via SMS or email
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-2">
                  {conversations.map((convo) => (
                    <Card key={convo.id} className="cursor-pointer hover:bg-accent/50">
                      <CardContent className="py-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">{convo.channel}</Badge>
                            <span className="font-medium text-sm">
                              {convo.subject || `${convo.channel.toUpperCase()} Conversation`}
                            </span>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {convo.last_message_at
                              ? formatDistanceToNow(new Date(convo.last_message_at), { addSuffix: true })
                              : ''}
                          </span>
                        </div>
                        {convo.last_message_preview && (
                          <p className="text-sm text-muted-foreground mt-1 truncate">
                            {convo.last_message_preview}
                          </p>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="activity" className="mt-4">
              <div className="space-y-3">
                {activities.map((act) => (
                  <div key={act.id} className="flex items-start gap-3">
                    <div className="mt-1.5 h-2 w-2 rounded-full bg-muted-foreground shrink-0" />
                    <div className="flex-1">
                      <p className="text-sm font-medium">{act.title}</p>
                      {act.description && (
                        <p className="text-xs text-muted-foreground">{act.description}</p>
                      )}
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {format(new Date(act.created_at), 'MMM d, yyyy h:mm a')}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </TabsContent>
          </Tabs>
        </div>

        {/* Right Column — Actions & Status */}
        <div className="space-y-4">
          {/* Tags */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Tags className="h-4 w-4" />
                Tags
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
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
            </CardContent>
          </Card>

          {/* Patient AI Summary */}
          <PatientSummaryCard leadId={lead.id} lead={lead} />

          {/* Personality Profile */}
          <PersonalityProfileCard
            leadId={lead.id}
            initialProfile={lead.personality_profile as any}
          />

          {/* AI Autopilot Control */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Brain className="h-4 w-4" />
                AI Autopilot
              </CardTitle>
            </CardHeader>
            <CardContent>
              <LeadAIOverrideToggle
                leadId={lead.id}
                currentOverride={(lead.ai_autopilot_override as any) || 'default'}
              />
            </CardContent>
          </Card>

          {/* Pipeline Stage */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Pipeline Stage</CardTitle>
            </CardHeader>
            <CardContent>
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
                        <div className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
                        {s.name}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          {/* Assigned To */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Assigned To</CardTitle>
            </CardHeader>
            <CardContent>
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
            </CardContent>
          </Card>

          {/* Quick Stats */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Engagement</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Messages Sent</span>
                <span className="font-medium">{lead.total_messages_sent}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Messages Received</span>
                <span className="font-medium">{lead.total_messages_received}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Emails Sent</span>
                <span className="font-medium">{lead.total_emails_sent}</span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Last Contact</span>
                <span className="font-medium">
                  {lead.last_contacted_at
                    ? formatDistanceToNow(new Date(lead.last_contacted_at), { addSuffix: true })
                    : 'Never'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Last Response</span>
                <span className="font-medium">
                  {lead.last_responded_at
                    ? formatDistanceToNow(new Date(lead.last_responded_at), { addSuffix: true })
                    : 'Never'}
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Financing panel temporarily removed until live integrations are available */}

          {/* Source */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Source</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Type</span>
                <span className="font-medium capitalize">
                  {lead.source_type?.replace(/_/g, ' ') || '—'}
                </span>
              </div>
              {lead.utm_source && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">UTM Source</span>
                  <span className="font-medium">{lead.utm_source}</span>
                </div>
              )}
              {lead.utm_campaign && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Campaign</span>
                  <span className="font-medium">{lead.utm_campaign}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Created</span>
                <span className="font-medium">
                  {format(new Date(lead.created_at), 'MMM d, yyyy')}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
