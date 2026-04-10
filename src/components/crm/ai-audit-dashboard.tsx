'use client'

import { useEffect, useState, useCallback } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Bot,
  User,
  Star,
  Flag,
  Loader2,
  ChevronDown,
  ChevronUp,
  Shield,
  MessageSquare,
  Phone,
  Target,
  AlertTriangle,
  CheckCircle2,
  ArrowRight,
} from 'lucide-react'
import { toast } from 'sonner'

// ════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════

type AuditConversation = {
  id: string
  lead_id: string
  channel: string
  status: string
  active_agent: string
  agent_handoff_count: number
  message_count: number
  last_message_at: string | null
  sentiment: string | null
  created_at: string
  lead: { id: string; first_name: string; last_name: string | null; status: string; ai_score: number; ai_qualification: string }
  ai_message_count: number
  avg_confidence: number | null
  rating: { rating: number; notes: string | null; flagged: boolean } | null
  analysis: { compliance_score: number | null; engagement_score: number | null; trust_score: number | null; coaching_notes: string | null } | null
  handoffs: Array<{ from_agent: string; to_agent: string; trigger_reason: string; created_at: string }>
}

type AuditStats = {
  total_ai_conversations: number
  avg_rating: number | null
  total_rated: number
  flagged_count: number
  setter_conversations: number
  closer_conversations: number
}

type ConversationMessage = {
  id: string
  direction: string
  body: string
  sender_type: string
  ai_generated: boolean
  ai_confidence: number | null
  metadata: Record<string, unknown> | null
  created_at: string
}

// ════════════════════════════════════════════════════════════════
// STAR RATING COMPONENT
// ════════════════════════════════════════════════════════════════

function StarRating({
  value,
  onChange,
  readonly = false,
}: {
  value: number
  onChange?: (v: number) => void
  readonly?: boolean
}) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          disabled={readonly}
          onClick={() => onChange?.(star)}
          className={`${readonly ? 'cursor-default' : 'cursor-pointer hover:scale-110'} transition-transform`}
        >
          <Star
            className={`h-4 w-4 ${
              star <= value
                ? 'fill-amber-400 text-amber-400'
                : 'text-gray-300'
            }`}
          />
        </button>
      ))}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// KPI CARDS
// ════════════════════════════════════════════════════════════════

function KPICards({ stats }: { stats: AuditStats }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MessageSquare className="h-4 w-4" />
            AI Conversations
          </div>
          <p className="text-2xl font-bold mt-1">{stats.total_ai_conversations}</p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Star className="h-4 w-4" />
            Avg Rating
          </div>
          <div className="flex items-center gap-2 mt-1">
            <p className="text-2xl font-bold">{stats.avg_rating ?? '—'}</p>
            <span className="text-xs text-muted-foreground">({stats.total_rated} rated)</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Flag className="h-4 w-4 text-red-500" />
            Flagged
          </div>
          <p className="text-2xl font-bold mt-1">{stats.flagged_count}</p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Bot className="h-4 w-4" />
            Agent Split
          </div>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 text-xs">
              <Phone className="h-3 w-3 mr-1" />
              {stats.setter_conversations}
            </Badge>
            <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200 text-xs">
              <Target className="h-3 w-3 mr-1" />
              {stats.closer_conversations}
            </Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// CONVERSATION ROW (expandable)
// ════════════════════════════════════════════════════════════════

function ConversationRow({
  conv,
  onRate,
}: {
  conv: AuditConversation
  onRate: (conversationId: string, rating: number, notes?: string, flagged?: boolean) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [ratingValue, setRatingValue] = useState(conv.rating?.rating || 0)
  const [ratingNotes, setRatingNotes] = useState(conv.rating?.notes || '')
  const [isFlagged, setIsFlagged] = useState(conv.rating?.flagged || false)
  const [saving, setSaving] = useState(false)

  async function loadMessages() {
    if (messages.length > 0) return
    setLoadingMessages(true)
    try {
      const res = await fetch(`/api/conversations/${conv.id}/messages`)
      if (res.ok) {
        const data = await res.json()
        setMessages(data.messages || [])
      }
    } catch {
      toast.error('Failed to load messages')
    } finally {
      setLoadingMessages(false)
    }
  }

  function handleExpand() {
    const willExpand = !expanded
    setExpanded(willExpand)
    if (willExpand) loadMessages()
  }

  async function handleSaveRating() {
    if (ratingValue === 0) return
    setSaving(true)
    try {
      await onRate(conv.id, ratingValue, ratingNotes || undefined, isFlagged)
      toast.success('Rating saved')
    } catch {
      toast.error('Failed to save rating')
    } finally {
      setSaving(false)
    }
  }

  const leadName = `${conv.lead.first_name} ${conv.lead.last_name || ''}`.trim()

  return (
    <div className="border rounded-lg">
      {/* Summary Row */}
      <button
        type="button"
        onClick={handleExpand}
        className="w-full flex items-center gap-3 p-4 hover:bg-muted/50 transition-colors text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{leadName}</span>
            <Badge variant="outline" className="text-[10px]">{conv.channel}</Badge>
            <Badge variant="outline" className={`text-[10px] ${
              conv.active_agent === 'setter' ? 'bg-blue-50 text-blue-700 border-blue-200' :
              conv.active_agent === 'closer' ? 'bg-purple-50 text-purple-700 border-purple-200' :
              ''
            }`}>
              {conv.active_agent === 'setter' ? 'Setter' : conv.active_agent === 'closer' ? 'Closer' : 'Manual'}
            </Badge>
            {conv.rating?.flagged && (
              <Flag className="h-3 w-3 text-red-500" />
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
            <span>{conv.message_count} msgs ({conv.ai_message_count} AI)</span>
            {conv.avg_confidence != null && (
              <span>Confidence: {(conv.avg_confidence * 100).toFixed(0)}%</span>
            )}
            {conv.analysis?.compliance_score != null && (
              <span className={conv.analysis.compliance_score < 80 ? 'text-red-500' : 'text-green-600'}>
                HIPAA: {conv.analysis.compliance_score}%
              </span>
            )}
            {conv.last_message_at && (
              <span>{formatDistanceToNow(new Date(conv.last_message_at), { addSuffix: true })}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {conv.rating ? (
            <StarRating value={conv.rating.rating} readonly />
          ) : (
            <span className="text-xs text-muted-foreground">Unrated</span>
          )}
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </div>
      </button>

      {/* Expanded Content */}
      {expanded && (
        <div className="border-t">
          {/* Analysis Summary */}
          {conv.analysis && (
            <div className="px-4 py-3 bg-muted/30 flex items-center gap-4 text-xs">
              {conv.analysis.engagement_score != null && (
                <span>Engagement: <strong>{conv.analysis.engagement_score}/10</strong></span>
              )}
              {conv.analysis.trust_score != null && (
                <span>Trust: <strong>{conv.analysis.trust_score}/10</strong></span>
              )}
              {conv.analysis.coaching_notes && (
                <span className="text-muted-foreground italic truncate flex-1" title={conv.analysis.coaching_notes}>
                  Coach: {conv.analysis.coaching_notes}
                </span>
              )}
            </div>
          )}

          {/* Handoff History */}
          {conv.handoffs.length > 0 && (
            <div className="px-4 py-2 bg-blue-50/50 border-b flex items-center gap-2 text-xs">
              <ArrowRight className="h-3 w-3 text-blue-500" />
              <span className="text-blue-700">
                {conv.handoffs.length} handoff{conv.handoffs.length > 1 ? 's' : ''}:
                {conv.handoffs.map((h, i) => (
                  <span key={i} className="ml-1">
                    {h.from_agent} → {h.to_agent}
                    {i < conv.handoffs.length - 1 ? ',' : ''}
                  </span>
                ))}
              </span>
            </div>
          )}

          {/* Message Thread */}
          <div className="p-4 max-h-96 overflow-y-auto space-y-3">
            {loadingMessages ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : messages.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-4">No messages</p>
            ) : (
              messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                      msg.direction === 'outbound'
                        ? 'bg-primary/10 border border-primary/20'
                        : 'bg-muted'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 mb-1 text-xs text-muted-foreground">
                      {msg.sender_type === 'ai' ? <Bot className="h-3 w-3" /> : <User className="h-3 w-3" />}
                      <span>{msg.sender_type === 'ai' ? 'AI' : msg.sender_type === 'lead' ? 'Patient' : 'Staff'}</span>
                      {msg.ai_generated && msg.metadata && (
                        <Badge variant="outline" className={`text-[9px] px-1 py-0 ${
                          (msg.metadata as Record<string, string>).agent === 'setter'
                            ? 'bg-blue-50 text-blue-600'
                            : (msg.metadata as Record<string, string>).agent === 'closer'
                              ? 'bg-purple-50 text-purple-600'
                              : ''
                        }`}>
                          {(msg.metadata as Record<string, string>).agent || 'AI'}
                        </Badge>
                      )}
                      {msg.ai_confidence != null && (
                        <span className="opacity-60">{(msg.ai_confidence * 100).toFixed(0)}%</span>
                      )}
                    </div>
                    <p className="whitespace-pre-wrap text-xs">{msg.body}</p>
                    <span className="text-[10px] text-muted-foreground/60 mt-1 block">
                      {formatDistanceToNow(new Date(msg.created_at), { addSuffix: true })}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>

          <Separator />

          {/* Rating Controls */}
          <div className="p-4 space-y-3">
            <div className="flex items-center gap-4">
              <div>
                <span className="text-xs text-muted-foreground block mb-1">Rate this conversation</span>
                <StarRating value={ratingValue} onChange={setRatingValue} />
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsFlagged(!isFlagged)}
                  className={`flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors ${
                    isFlagged
                      ? 'bg-red-50 border-red-200 text-red-700'
                      : 'border-gray-200 text-muted-foreground hover:border-red-200 hover:text-red-600'
                  }`}
                >
                  <Flag className="h-3 w-3" />
                  {isFlagged ? 'Flagged' : 'Flag'}
                </button>
              </div>

              <Button
                size="sm"
                onClick={handleSaveRating}
                disabled={saving || ratingValue === 0}
                className="ml-auto"
              >
                {saving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <CheckCircle2 className="h-3 w-3 mr-1" />}
                Save Rating
              </Button>
            </div>

            <Textarea
              value={ratingNotes}
              onChange={(e) => setRatingNotes(e.target.value)}
              placeholder="Optional notes about this conversation quality..."
              rows={2}
              className="text-xs"
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// MAIN DASHBOARD
// ════════════════════════════════════════════════════════════════

export function AiAuditDashboard() {
  const [conversations, setConversations] = useState<AuditConversation[]>([])
  const [stats, setStats] = useState<AuditStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [agentFilter, setAgentFilter] = useState('all')
  const [ratedFilter, setRatedFilter] = useState('all')
  const [flaggedFilter, setFlaggedFilter] = useState('all')
  const limit = 15

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: limit.toString(),
        agent: agentFilter,
        rated: ratedFilter,
        flagged: flaggedFilter,
      })

      const res = await fetch(`/api/ai/audit?${params}`)
      if (!res.ok) throw new Error()
      const data = await res.json()

      setConversations(data.conversations)
      setTotal(data.total)
      setStats(data.stats)
    } catch {
      toast.error('Failed to load audit data')
    } finally {
      setLoading(false)
    }
  }, [page, agentFilter, ratedFilter, flaggedFilter])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  async function handleRate(conversationId: string, rating: number, notes?: string, flagged?: boolean) {
    const res = await fetch('/api/ai/audit/rate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: conversationId, rating, notes, flagged }),
    })
    if (!res.ok) throw new Error()

    // Update local state
    setConversations(prev =>
      prev.map(c =>
        c.id === conversationId
          ? { ...c, rating: { rating, notes: notes || null, flagged: flagged || false } }
          : c
      )
    )
  }

  const totalPages = Math.ceil(total / limit)

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      {stats && <KPICards stats={stats} />}

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <Select value={agentFilter} onValueChange={(v) => { if (v) { setAgentFilter(v); setPage(1) } }}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Agent" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Agents</SelectItem>
            <SelectItem value="setter">Setter Only</SelectItem>
            <SelectItem value="closer">Closer Only</SelectItem>
          </SelectContent>
        </Select>

        <Select value={ratedFilter} onValueChange={(v) => { if (v) { setRatedFilter(v); setPage(1) } }}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Rating" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="false">Unrated</SelectItem>
            <SelectItem value="true">Rated</SelectItem>
          </SelectContent>
        </Select>

        <Select value={flaggedFilter} onValueChange={(v) => { if (v) { setFlaggedFilter(v); setPage(1) } }}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Flagged" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="true">Flagged Only</SelectItem>
          </SelectContent>
        </Select>

        <span className="text-sm text-muted-foreground ml-auto">
          {total} conversation{total !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Conversation List */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : conversations.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Shield className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
            <p className="text-muted-foreground">No AI conversations found matching filters.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {conversations.map((conv) => (
            <ConversationRow key={conv.id} conv={conv} onRate={handleRate} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  )
}
