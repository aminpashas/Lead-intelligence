'use client'

import { useEffect, useState, useCallback } from 'react'
import { formatDistanceToNow } from 'date-fns'
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
                ? 'fill-aurea-amber text-aurea-amber'
                : 'text-aurea-border'
            }`}
            strokeWidth={1.75}
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
  const kpis = [
    {
      index: '01',
      label: 'AI Conversations',
      value: stats.total_ai_conversations,
      sub: 'total audited',
      icon: MessageSquare,
    },
    {
      index: '02',
      label: 'Avg Rating',
      value: stats.avg_rating ?? '—',
      sub: `${stats.total_rated} rated`,
      icon: Star,
    },
    {
      index: '03',
      label: 'Flagged',
      value: stats.flagged_count,
      sub: 'need review',
      icon: Flag,
      accent: stats.flagged_count > 0 ? 'rose' as const : undefined,
    },
    {
      index: '04',
      label: 'Agent Split',
      value: `${stats.setter_conversations}/${stats.closer_conversations}`,
      sub: 'setter / closer',
      icon: Bot,
    },
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {kpis.map((kpi) => (
        <div key={kpi.label} className="aurea-card p-5">
          <div className="flex items-center justify-between">
            <p className="aurea-eyebrow">{kpi.label}</p>
            <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3">/{kpi.index}</span>
          </div>
          <p className={`mt-4 aurea-display text-[36px] tabular-nums ${
            kpi.accent === 'rose' ? 'text-aurea-rose' : 'text-aurea-ink'
          }`}>
            {kpi.value}
          </p>
          <p className="mt-2 text-[11.5px] text-aurea-ink-3">{kpi.sub}</p>
        </div>
      ))}
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
    <div className="aurea-card overflow-hidden">
      {/* Summary Row */}
      <button
        type="button"
        onClick={handleExpand}
        className="w-full flex items-center gap-3 p-4 hover:bg-aurea-surface-2 transition-colors text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[14px] font-medium text-aurea-ink">{leadName}</span>
            <Badge variant="outline" className="text-[10px]">{conv.channel}</Badge>
            <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${
              conv.active_agent === 'setter'
                ? 'border-aurea-primary/30 bg-aurea-primary/5 text-aurea-primary'
                : conv.active_agent === 'closer'
                ? 'border-aurea-amber/30 bg-aurea-amber/5 text-aurea-amber'
                : 'border-aurea-border bg-aurea-surface-2 text-aurea-ink-3'
            }`}>
              {conv.active_agent === 'setter' ? 'Setter' : conv.active_agent === 'closer' ? 'Closer' : 'Manual'}
            </span>
            {conv.rating?.flagged && (
              <Flag className="h-3 w-3 text-aurea-rose" strokeWidth={1.75} />
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 font-mono text-[11px] text-aurea-ink-3">
            <span>{conv.message_count} msgs ({conv.ai_message_count} AI)</span>
            {conv.avg_confidence != null && (
              <span>Conf: {(conv.avg_confidence * 100).toFixed(0)}%</span>
            )}
            {conv.analysis?.compliance_score != null && (
              <span className={conv.analysis.compliance_score < 80 ? 'text-aurea-rose' : 'text-aurea-primary'}>
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
            <span className="text-[12px] text-aurea-ink-3">Unrated</span>
          )}
          {expanded
            ? <ChevronUp className="h-4 w-4 text-aurea-ink-3" strokeWidth={1.75} />
            : <ChevronDown className="h-4 w-4 text-aurea-ink-3" strokeWidth={1.75} />
          }
        </div>
      </button>

      {/* Expanded Content */}
      {expanded && (
        <div className="border-t border-aurea-border">
          {/* Analysis Summary */}
          {conv.analysis && (
            <div className="px-4 py-3 bg-aurea-surface-2 flex items-center gap-4 text-[12px] text-aurea-ink-2">
              {conv.analysis.engagement_score != null && (
                <span>Engagement: <strong className="text-aurea-ink">{conv.analysis.engagement_score}/10</strong></span>
              )}
              {conv.analysis.trust_score != null && (
                <span>Trust: <strong className="text-aurea-ink">{conv.analysis.trust_score}/10</strong></span>
              )}
              {conv.analysis.coaching_notes && (
                <span className="text-aurea-ink-3 italic truncate flex-1" title={conv.analysis.coaching_notes}>
                  Coach: {conv.analysis.coaching_notes}
                </span>
              )}
            </div>
          )}

          {/* Handoff History */}
          {conv.handoffs.length > 0 && (
            <div className="px-4 py-2.5 bg-aurea-surface-2 border-t border-b border-aurea-border flex items-center gap-2 text-[12px]">
              <ArrowRight className="h-3 w-3 text-aurea-primary" strokeWidth={1.75} />
              <span className="text-aurea-ink-2">
                {conv.handoffs.length} handoff{conv.handoffs.length > 1 ? 's' : ''}:
                {conv.handoffs.map((h, i) => (
                  <span key={i} className="ml-1 font-medium text-aurea-ink">
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
                <Loader2 className="h-5 w-5 animate-spin text-aurea-ink-3" />
              </div>
            ) : messages.length === 0 ? (
              <p className="text-center text-[13px] text-aurea-ink-3 py-4">No messages</p>
            ) : (
              messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[75%] rounded-lg px-3 py-2 text-[13px] ${
                      msg.direction === 'outbound'
                        ? 'bg-aurea-primary/[0.06] border border-aurea-primary/15'
                        : 'bg-aurea-surface-2 border border-aurea-border'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 mb-1 text-[11px] text-aurea-ink-3">
                      {msg.sender_type === 'ai'
                        ? <Bot className="h-3 w-3" strokeWidth={1.75} />
                        : <User className="h-3 w-3" strokeWidth={1.75} />
                      }
                      <span>{msg.sender_type === 'ai' ? 'AI' : msg.sender_type === 'lead' ? 'Patient' : 'Staff'}</span>
                      {msg.ai_generated && msg.metadata && (
                        <span className={`inline-flex items-center rounded border px-1 py-0 text-[9px] font-medium ${
                          (msg.metadata as Record<string, string>).agent === 'setter'
                            ? 'border-aurea-primary/30 bg-aurea-primary/5 text-aurea-primary'
                            : (msg.metadata as Record<string, string>).agent === 'closer'
                            ? 'border-aurea-amber/30 bg-aurea-amber/5 text-aurea-amber'
                            : 'border-aurea-border bg-aurea-surface-2 text-aurea-ink-3'
                        }`}>
                          {(msg.metadata as Record<string, string>).agent || 'AI'}
                        </span>
                      )}
                      {msg.ai_confidence != null && (
                        <span className="font-mono opacity-60">{(msg.ai_confidence * 100).toFixed(0)}%</span>
                      )}
                    </div>
                    <p className="whitespace-pre-wrap text-[12px] text-aurea-ink">{msg.body}</p>
                    <span className="font-mono text-[10px] text-aurea-ink-3/60 mt-1 block">
                      {formatDistanceToNow(new Date(msg.created_at), { addSuffix: true })}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>

          <Separator className="bg-aurea-border" />

          {/* Rating Controls */}
          <div className="p-4 space-y-3">
            <div className="flex items-center gap-4 flex-wrap">
              <div>
                <span className="aurea-eyebrow mb-1 block">Rate this conversation</span>
                <StarRating value={ratingValue} onChange={setRatingValue} />
              </div>

              <button
                type="button"
                onClick={() => setIsFlagged(!isFlagged)}
                className={`flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-md border transition-colors ${
                  isFlagged
                    ? 'border-aurea-rose/30 bg-aurea-rose/5 text-aurea-rose'
                    : 'border-aurea-border text-aurea-ink-3 hover:border-aurea-rose/30 hover:text-aurea-rose'
                }`}
              >
                <Flag className="h-3 w-3" strokeWidth={1.75} />
                {isFlagged ? 'Flagged' : 'Flag'}
              </button>

              <Button
                size="sm"
                onClick={handleSaveRating}
                disabled={saving || ratingValue === 0}
                className="ml-auto gap-1.5"
              >
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" strokeWidth={1.75} />}
                Save Rating
              </Button>
            </div>

            <Textarea
              value={ratingNotes}
              onChange={(e) => setRatingNotes(e.target.value)}
              placeholder="Optional notes about this conversation quality..."
              rows={2}
              className="text-[12px]"
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
        <Select items={{ all: 'All Agents', setter: 'Setter Only', closer: 'Closer Only' }} value={agentFilter} onValueChange={(v) => { if (v) { setAgentFilter(v); setPage(1) } }}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Agent" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Agents</SelectItem>
            <SelectItem value="setter">Setter Only</SelectItem>
            <SelectItem value="closer">Closer Only</SelectItem>
          </SelectContent>
        </Select>

        <Select items={{ all: 'All', false: 'Unrated', true: 'Rated' }} value={ratedFilter} onValueChange={(v) => { if (v) { setRatedFilter(v); setPage(1) } }}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Rating" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="false">Unrated</SelectItem>
            <SelectItem value="true">Rated</SelectItem>
          </SelectContent>
        </Select>

        <Select items={{ all: 'All', true: 'Flagged Only' }} value={flaggedFilter} onValueChange={(v) => { if (v) { setFlaggedFilter(v); setPage(1) } }}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Flagged" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="true">Flagged Only</SelectItem>
          </SelectContent>
        </Select>

        <span className="font-mono text-[12px] tabular-nums text-aurea-ink-3 ml-auto">
          {total} conversation{total !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Conversation List */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-aurea-ink-3" />
        </div>
      ) : conversations.length === 0 ? (
        <div className="aurea-card p-12 text-center">
          <Shield className="h-8 w-8 mx-auto text-aurea-ink-3 mb-3" strokeWidth={1.75} />
          <p className="text-[13px] text-aurea-ink-3">No AI conversations found matching filters.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {conversations.map((conv) => (
            <ConversationRow key={conv.id} conv={conv} onRate={handleRate} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
          >
            Previous
          </Button>
          <span className="font-mono text-[12px] tabular-nums text-aurea-ink-3">
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
