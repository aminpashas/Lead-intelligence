'use client'

import { useState, useRef, useEffect } from 'react'
import { format, isToday, isYesterday } from 'date-fns'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Send,
  Brain,
  Loader2,
  Sparkles,
  User,
  Bot,
  Heart,
  Eye,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  Shield,
  AlertTriangle,
  MessageSquare,
} from 'lucide-react'
import { toast } from 'sonner'
import type { Conversation, Message, Lead, AgentType, VoiceCall } from '@/types/database'
import { AgentIndicator, AgentMessageLabel } from './agent-indicator'
import { AIModeToggle } from './ai-mode-toggle'
import { LeadActions } from './lead-actions'
import { LiveCallIndicator, LiveCallPanel } from './live-call-panel'
import { CallCard } from './call-card'
import { useLiveCall } from '@/lib/hooks/use-live-call'

// ── Thread shaping ──────────────────────────────────────────
// Consecutive messages from the same sender within this window render as one
// visual group (single meta line, tight bubbles) instead of repeating labels.
const GROUP_WINDOW_MS = 8 * 60 * 1000

type ThreadItem =
  | { type: 'day'; key: string; label: string }
  | { type: 'group'; key: string; messages: Message[] }
  | { type: 'call'; key: string; call: VoiceCall }

function agentOf(msg: Message): string {
  return ((msg.metadata as Record<string, string> | null)?.agent) || ''
}

// A completed call sits in the timeline at the moment it ended.
function callTime(call: VoiceCall): number {
  return new Date(call.ended_at || call.started_at || call.created_at).getTime()
}

function buildThread(messages: Message[], calls: VoiceCall[]): ThreadItem[] {
  // Interleave messages and finished calls into one time-ordered stream. Calls
  // are standalone cards, so they break any in-progress message group.
  type Ev = { t: number; msg?: Message; call?: VoiceCall }
  const events: Ev[] = [
    ...messages.map((m) => ({ t: new Date(m.created_at).getTime(), msg: m })),
    ...calls.map((c) => ({ t: callTime(c), call: c })),
  ].sort((a, b) => a.t - b.t)

  const items: ThreadItem[] = []
  let group: Message[] = []
  let lastDay = ''

  const flush = () => {
    if (group.length) {
      items.push({ type: 'group', key: group[0].id, messages: group })
      group = []
    }
  }

  for (const ev of events) {
    const d = new Date(ev.t)
    const day = format(d, 'yyyy-MM-dd')
    if (day !== lastDay) {
      flush()
      items.push({
        type: 'day',
        key: day,
        label: isToday(d) ? 'Today' : isYesterday(d) ? 'Yesterday' : format(d, 'EEEE, MMM d'),
      })
      lastDay = day
    }

    if (ev.call) {
      flush()
      items.push({ type: 'call', key: `call-${ev.call.id}`, call: ev.call })
      continue
    }

    const msg = ev.msg!
    const prev = group[group.length - 1]
    const continues =
      prev &&
      prev.direction === msg.direction &&
      prev.sender_type === msg.sender_type &&
      agentOf(prev) === agentOf(msg) &&
      d.getTime() - new Date(prev.created_at).getTime() < GROUP_WINDOW_MS
    if (!continues) flush()
    group.push(msg)
  }
  flush()
  return items
}

export function ConversationThread({
  lead,
  conversation,
  messages: initialMessages,
  calls = [],
}: {
  lead: Lead
  conversation: Conversation
  messages: Message[]
  calls?: VoiceCall[]
}) {
  const [messages, setMessages] = useState(initialMessages)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [aiMode, setAiMode] = useState<string>('education')
  const [analyzing, setAnalyzing] = useState(false)
  const [generatingFollowUp, setGeneratingFollowUp] = useState(false)
  const [analysisResult, setAnalysisResult] = useState<Record<string, unknown> | null>(null)
  const [followUpResult, setFollowUpResult] = useState<Record<string, unknown> | null>(null)
  const [showInsights, setShowInsights] = useState(false)
  const [activeAgent, setActiveAgent] = useState<AgentType>(conversation.active_agent || 'setter')
  const [agentNotes, setAgentNotes] = useState<string | null>(null)
  const [techniquesUsed, setTechniquesUsed] = useState<Array<{ technique_id: string; confidence: number; effectiveness: string; context_note: string }>>([])
  const [leadAssessment, setLeadAssessment] = useState<{ engagement_temperature: number; resistance_level: number; buying_readiness: number; emotional_state: string } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Live phone-call state (ongoing-call indicator + streaming transcript).
  const live = useLiveCall(lead.id)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  async function handleSend() {
    if (!draft.trim()) return
    setSending(true)

    try {
      const endpoint = conversation.channel === 'sms' ? '/api/sms/send' : '/api/email/send'
      const payload = conversation.channel === 'sms'
        ? { lead_id: lead.id, message: draft }
        : { lead_id: lead.id, subject: conversation.subject || 'Follow up', body: draft }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!res.ok) throw new Error('Failed to send')

      const { message } = await res.json()
      setMessages((prev) => [...prev, message])
      setDraft('')
      toast.success('Message sent')
    } catch {
      toast.error('Failed to send message')
    } finally {
      setSending(false)
    }
  }

  async function generateAIMessage() {
    setGenerating(true)
    setAgentNotes(null)
    try {
      // Use agent system for smart routing between Setter/Closer
      const res = await fetch('/api/ai/agent-respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversation.id,
        }),
      })

      if (!res.ok) throw new Error('AI generation failed')

      const data = await res.json()
      setDraft(data.message)
      if (data.agent) setActiveAgent(data.agent)
      if (data.internal_notes) setAgentNotes(data.internal_notes)
      if (data.techniques_used) setTechniquesUsed(data.techniques_used)
      if (data.lead_assessment) setLeadAssessment(data.lead_assessment)
      toast.success(`${data.agent === 'closer' ? 'Closer' : 'Setter'} agent draft — review and send`)
    } catch {
      // Fallback to legacy engage endpoint
      try {
        const res = await fetch('/api/ai/engage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lead_id: lead.id,
            conversation_id: conversation.id,
            mode: aiMode,
            channel: conversation.channel,
          }),
        })
        if (res.ok) {
          const { message } = await res.json()
          setDraft(message)
          toast.success('AI draft generated (fallback) — review and send')
        } else {
          throw new Error('Fallback also failed')
        }
      } catch {
        toast.error('Failed to generate AI message')
      }
    } finally {
      setGenerating(false)
    }
  }

  async function analyzeConversation() {
    if (messages.length < 2) {
      toast.error('Need at least 2 messages to analyze')
      return
    }
    setAnalyzing(true)
    try {
      const res = await fetch('/api/ai/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversation.id,
          lead_id: lead.id,
        }),
      })
      if (!res.ok) throw new Error('Analysis failed')
      const data = await res.json()
      setAnalysisResult(data)
      setShowInsights(true)
      toast.success('Conversation analyzed — insights available')
    } catch {
      toast.error('Failed to analyze conversation')
    } finally {
      setAnalyzing(false)
    }
  }

  async function getFollowUpPlan() {
    setGeneratingFollowUp(true)
    try {
      const res = await fetch('/api/ai/follow-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead_id: lead.id,
          channel: conversation.channel,
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        if (err.error?.includes('No patient profile')) {
          toast.error('Analyze the conversation first to build a patient profile')
          return
        }
        throw new Error('Failed')
      }
      const data = await res.json()
      setFollowUpResult(data)
      // Pre-fill draft with the opening message
      if (data.follow_up?.opening_message) {
        setDraft(data.follow_up.opening_message)
      }
      setShowInsights(true)
      toast.success('Follow-up plan generated')
    } catch {
      toast.error('Failed to generate follow-up plan')
    } finally {
      setGeneratingFollowUp(false)
    }
  }

  const thread = buildThread(messages, calls)
  const initials = `${lead.first_name?.[0] ?? ''}${lead.last_name?.[0] ?? ''}`.toUpperCase() || '?'
  const smsSegments = Math.max(1, Math.ceil(draft.length / 160))

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-aurea-border bg-aurea-surface">
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-aurea-border px-4 py-3 lg:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/conversations"
            aria-label="Back to conversations"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-aurea-border text-aurea-ink-3 transition-colors hover:bg-aurea-surface-2 hover:text-aurea-ink"
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
          </Link>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-aurea-border bg-aurea-surface-2">
            <span className="aurea-display text-[14px] text-aurea-ink-2">{initials}</span>
          </div>
          <div className="min-w-0">
            <h3 className="aurea-display truncate text-[20px] text-aurea-ink">
              {lead.first_name} {lead.last_name}
            </h3>
            <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-aurea-ink-3">
              <span className="font-mono uppercase tracking-[0.12em]">{conversation.channel}</span>
              {lead.phone && (
                <>
                  <span className="text-aurea-border-strong">·</span>
                  <span>{lead.phone}</span>
                </>
              )}
              <span className="text-aurea-border-strong">·</span>
              <span>{messages.length} messages</span>
              {conversation.sentiment && (
                <>
                  <span className="text-aurea-border-strong">·</span>
                  <span className="capitalize">{conversation.sentiment}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <LiveCallIndicator live={live} />
          <LeadActions lead={lead} variant="compact" />
          <AgentIndicator
            activeAgent={activeAgent}
            conversationId={conversation.id}
            handoffCount={conversation.agent_handoff_count}
            onAgentChange={setActiveAgent}
          />
          <AIModeToggle
            conversationId={conversation.id}
            currentMode={conversation.ai_mode || 'off'}
            size="sm"
            showLabel={false}
          />
          <div className="h-6 w-px bg-aurea-border" />
          <Button
            variant="outline"
            size="sm"
            onClick={analyzeConversation}
            disabled={analyzing || messages.length < 2}
            className="gap-1.5"
          >
            {analyzing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" strokeWidth={1.75} />}
            Analyze
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={getFollowUpPlan}
            disabled={generatingFollowUp}
            className="gap-1.5"
          >
            {generatingFollowUp ? <Loader2 className="h-3 w-3 animate-spin" /> : <Heart className="h-3 w-3" strokeWidth={1.75} />}
            Smart Follow-Up
          </Button>
          {(analysisResult || followUpResult) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowInsights(!showInsights)}
              className="gap-1"
            >
              {showInsights ? <ChevronUp className="h-3 w-3" strokeWidth={1.75} /> : <ChevronDown className="h-3 w-3" strokeWidth={1.75} />}
              Insights
            </Button>
          )}
        </div>
      </div>

      {/* AI Insights Panel */}
      {showInsights && (analysisResult || followUpResult) && (
        <InsightsPanel analysisResult={analysisResult} followUpResult={followUpResult} />
      )}

      {/* ── Messages ───────────────────────────────────────── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-aurea-canvas px-4 py-5 lg:px-6">
        <div className="mx-auto w-full max-w-[720px] space-y-5">
          {thread.map((item) =>
            item.type === 'day' ? (
              <div key={item.key} className="flex items-center gap-4 pt-2">
                <div className="h-px flex-1 bg-aurea-border" />
                <span className="aurea-eyebrow">{item.label}</span>
                <div className="h-px flex-1 bg-aurea-border" />
              </div>
            ) : item.type === 'call' ? (
              <CallCard key={item.key} call={item.call} />
            ) : (
              <MessageGroup key={item.key} messages={item.messages} lead={lead} />
            )
          )}

          {messages.length === 0 && calls.length === 0 && live.status === 'idle' && (
            <div className="flex flex-col items-center py-16 text-center">
              <MessageSquare className="mb-3 h-7 w-7 text-aurea-ink-3" strokeWidth={1.5} />
              <p className="text-[14px] font-medium text-aurea-ink">No messages yet</p>
              <p className="mt-1 text-[13px] text-aurea-ink-3">Start the conversation below.</p>
            </div>
          )}

          {/* Live call — streams the transcript in as the call happens */}
          <LiveCallPanel live={live} />
        </div>
      </div>

      {/* ── Compose ────────────────────────────────────────── */}
      <div className="border-t border-aurea-border px-4 py-4 lg:px-6">
        <div className="mx-auto w-full max-w-[720px] space-y-3">
          {/* Agent notes (staff-visible reasoning from the AI) */}
          {agentNotes && (
            <div className="flex items-start gap-2 rounded-lg border border-aurea-amber/30 bg-aurea-amber/10 p-2.5 text-sm">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-aurea-amber" strokeWidth={1.75} />
              <div>
                <span className="text-xs font-medium text-aurea-amber">Agent Notes:</span>
                <p className="mt-0.5 text-xs text-aurea-ink-2">{agentNotes}</p>
              </div>
            </div>
          )}

          {/* Sales technique tracking display */}
          {(techniquesUsed.length > 0 || leadAssessment) && (
            <div className="space-y-2 rounded-lg border border-aurea-border bg-aurea-surface-2 p-2.5 text-xs">
              {techniquesUsed.length > 0 && (
                <div>
                  <span className="font-medium text-aurea-ink">Techniques Used:</span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {techniquesUsed.map((t, i) => (
                      <span
                        key={i}
                        className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium ${
                          t.effectiveness === 'effective'
                            ? 'border-aurea-primary/20 bg-aurea-primary/10 text-aurea-primary'
                            : t.effectiveness === 'backfired'
                              ? 'border-aurea-rose/20 bg-aurea-rose/10 text-aurea-rose'
                              : 'border-aurea-border bg-aurea-surface text-aurea-ink-3'
                        }`}
                        title={t.context_note}
                      >
                        {t.technique_id.replace(/_/g, ' ').replace(/^[a-z]+\s/, '')}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {leadAssessment && (
                <div className="flex items-center gap-3 text-aurea-ink-2">
                  <span>Engagement: <strong>{leadAssessment.engagement_temperature}/10</strong></span>
                  <span>Resistance: <strong>{leadAssessment.resistance_level}/10</strong></span>
                  <span>Buying Ready: <strong>{leadAssessment.buying_readiness}/10</strong></span>
                  <span>State: <strong>{leadAssessment.emotional_state}</strong></span>
                </div>
              )}
            </div>
          )}

          {/* Message input */}
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              conversation.channel === 'sms'
                ? `Text ${lead.first_name || 'this lead'}...`
                : `Email ${lead.first_name || 'this lead'}...`
            }
            rows={3}
            className="resize-none text-[13.5px]"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                handleSend()
              }
            }}
          />

          {/* Toolbar */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={generateAIMessage}
                disabled={generating}
                className="gap-1.5"
                title={`Auto-selects ${activeAgent === 'closer' ? 'Closer' : 'Setter'} based on lead stage`}
              >
                {generating ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Brain className="h-3 w-3 text-aurea-primary" strokeWidth={1.75} />
                )}
                AI Agent Draft
              </Button>
              {/* Legacy mode selector as fallback */}
              <Select value={aiMode} onValueChange={(v) => v && setAiMode(v)}>
                <SelectTrigger className="h-8 w-32 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="education">Educate</SelectItem>
                  <SelectItem value="objection_handling">Objections</SelectItem>
                  <SelectItem value="appointment_scheduling">Schedule</SelectItem>
                  <SelectItem value="follow_up">Follow Up</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-3">
              {conversation.channel === 'sms' && draft.length > 0 && (
                <span className={`text-[11px] tabular-nums ${draft.length > 320 ? 'text-aurea-amber' : 'text-aurea-ink-3'}`}>
                  {draft.length} · {smsSegments} segment{smsSegments > 1 ? 's' : ''}
                </span>
              )}
              <span className="hidden text-[11px] text-aurea-ink-3 sm:inline">⌘↵ to send</span>
              <Button
                onClick={handleSend}
                disabled={sending || !draft.trim()}
                size="sm"
                className="gap-1.5"
              >
                {sending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" strokeWidth={1.75} />
                )}
                Send
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Message group ───────────────────────────────────────────
// One meta line (sender · agent · time) above a tight stack of bubbles.

function MessageGroup({ messages, lead }: { messages: Message[]; lead: Lead }) {
  const first = messages[0]
  const outbound = first.direction === 'outbound'
  const isAI = first.sender_type === 'ai'
  const hasAIDraft = messages.some((m) => m.ai_generated)

  const senderLabel = isAI
    ? 'AI'
    : first.sender_name ||
      (first.direction === 'inbound'
        ? `${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim() || 'Lead'
        : 'You')

  return (
    <div className={`flex flex-col ${outbound ? 'items-end' : 'items-start'}`}>
      {/* Meta line */}
      <div className="mb-1 flex items-center gap-1.5 px-1 text-[11px] text-aurea-ink-3">
        {isAI ? (
          <Bot className="h-3 w-3 text-aurea-primary" strokeWidth={1.75} />
        ) : (
          <User className="h-3 w-3" strokeWidth={1.75} />
        )}
        <span className="font-medium text-aurea-ink-2">{senderLabel}</span>
        {isAI && <AgentMessageLabel agent={agentOf(first)} />}
        {!isAI && hasAIDraft && (
          <Sparkles className="h-3 w-3 text-aurea-primary" strokeWidth={1.75} aria-label="AI-drafted" />
        )}
        <span className="text-aurea-border-strong">·</span>
        <span>{format(new Date(first.created_at), 'h:mm a')}</span>
      </div>

      {/* Bubbles */}
      <div className={`flex max-w-[85%] flex-col gap-1 ${outbound ? 'items-end' : 'items-start'}`}>
        {messages.map((msg, i) => {
          const last = i === messages.length - 1
          return (
            <div key={msg.id} className={`flex flex-col ${outbound ? 'items-end' : 'items-start'}`}>
              <div
                title={format(new Date(msg.created_at), 'MMM d, h:mm a')}
                className={`rounded-2xl px-3.5 py-2.5 ${
                  outbound
                    ? `bg-aurea-ink text-aurea-canvas ${last ? 'rounded-br-md' : ''}`
                    : `border border-aurea-border bg-aurea-surface text-aurea-ink ${last ? 'rounded-bl-md' : ''}`
                }`}
              >
                <p className="whitespace-pre-wrap text-[13.5px] leading-[1.55]">{msg.body}</p>
              </div>
              {msg.status === 'failed' && (
                <span className="mt-1 rounded border border-aurea-rose/30 bg-aurea-rose/10 px-1.5 py-0.5 text-[10px] font-medium text-aurea-rose">
                  Failed to deliver
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Insights Panel ──────────────────────────────────────────
// Editorial layout: uniform meter cells for scores, ruled quote block for AI
// prose, all constrained to the same reading column as the thread.

// A single metric as a hairline row: label · meter · number. `invert` marks
// metrics where high is bad (sales pressure, anxiety) so the tone flips.
function MeterRow({ label, value, invert }: { label: string; value: number; invert?: boolean }) {
  const v = Math.max(0, Math.min(10, Number(value) || 0))
  const good = invert ? v <= 3 : v >= 7
  const bad = invert ? v >= 7 : v <= 3
  const tone = bad ? 'bg-aurea-rose/70' : good ? 'bg-aurea-primary/80' : 'bg-aurea-ink-2/50'
  return (
    <div className="flex items-center gap-3 py-[7px]">
      <span className="w-[104px] shrink-0 text-[11px] text-aurea-ink-3">{label}</span>
      <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-aurea-surface-2">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${v * 10}%` }} />
      </div>
      <span className="aurea-display w-9 shrink-0 text-right text-[15px] tabular-nums text-aurea-ink">
        {value}<span className="text-[10px] text-aurea-ink-3">/10</span>
      </span>
    </div>
  )
}

function FactCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-l border-aurea-border-strong/60 pl-3">
      <div className="text-[10px] uppercase tracking-[0.1em] text-aurea-ink-3">{label}</div>
      <div className="mt-0.5 truncate text-[13px] font-medium capitalize text-aurea-ink" title={value}>
        {value}
      </div>
    </div>
  )
}

// The analyst writes coaching notes as "1. HEADLINE: body 2. NEXT: ..." —
// split that into structured directives; anything else falls back to prose.
const CAPS_KEEP = new Set(['AI', 'SMS', 'MSG', 'HIPAA', 'PHI', 'CRM', 'ASAP'])

function sentenceCase(s: string): string {
  const out = s
    .split(' ')
    .map((w) => (CAPS_KEEP.has(w) ? w : w.toLowerCase()))
    .join(' ')
  return out.charAt(0).toUpperCase() + out.slice(1)
}

function parseCoachingNotes(text: string): { intro: string; items: Array<{ lead: string; body: string }> } {
  // Only treat "N." as an item boundary when N is the next expected number,
  // so numbers inside a sentence ("promised in MSG 15. Add a note") don't split.
  const cuts: Array<{ start: number; end: number }> = []
  let expected = 1
  for (const m of text.matchAll(/(?:^|\s)(\d{1,2})\.\s+(?=[A-Z])/g)) {
    if (Number(m[1]) === expected && m.index != null) {
      cuts.push({ start: m.index, end: m.index + m[0].length })
      expected++
    }
  }
  if (cuts.length < 2) return { intro: text, items: [] }
  const intro = text.slice(0, cuts[0].start).trim()
  const items = cuts.map((c, i) => {
    const seg = text.slice(c.end, i + 1 < cuts.length ? cuts[i + 1].start : undefined).trim()
    const lead = seg.match(/^([A-Z][A-Z0-9 ,'&/-]{2,60}):\s*/)
    return lead ? { lead: sentenceCase(lead[1]), body: seg.slice(lead[0].length) } : { lead: '', body: seg }
  })
  return { intro, items }
}

function CoachingNotes({ text }: { text: string }) {
  const { intro, items } = parseCoachingNotes(text)
  return (
    <div className="border-l-2 border-aurea-gold py-1 pl-3.5">
      <div className="aurea-eyebrow mb-1.5">Coaching Notes</div>
      {intro && <p className="mb-2 text-[12.5px] leading-relaxed text-aurea-ink-2">{intro}</p>}
      {items.length > 0 && (
        <ol className="space-y-2">
          {items.map((it, i) => (
            <li key={i} className="flex gap-2.5 text-[12.5px] leading-relaxed">
              <span className="aurea-display shrink-0 tabular-nums text-aurea-gold">{i + 1}</span>
              <span className="text-aurea-ink-2">
                {it.lead && <span className="font-medium text-aurea-ink">{it.lead}. </span>}
                {it.body}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function PointList({ title, items, tone }: { title: string; items: string[]; tone: 'primary' | 'amber' }) {
  return (
    <div>
      <div className={`aurea-eyebrow mb-1.5 ${tone === 'primary' ? '!text-aurea-primary' : '!text-aurea-amber'}`}>
        {title}
      </div>
      <ul className="space-y-1 text-[12.5px] leading-relaxed text-aurea-ink-2">
        {items.map((p, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-aurea-ink-3">&mdash;</span>
            <span>{p}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="aurea-eyebrow whitespace-nowrap">{children}</span>
      <div className="h-px flex-1 bg-aurea-border" />
    </div>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function InsightsPanel({ analysisResult, followUpResult }: { analysisResult: any; followUpResult: any }) {
  const ca = analysisResult?.conversation_analysis
  const pp = analysisResult?.patient_profile
  const fu = followUpResult?.follow_up

  return (
    <div className="max-h-[min(480px,55vh)] overflow-y-auto border-b border-aurea-border bg-aurea-surface">
      <div className="mx-auto w-full max-w-[720px] space-y-5 px-4 py-4 lg:px-0">
        {ca && (
          <section className="space-y-3">
            <SectionHeading>Conversation Analysis</SectionHeading>

            {/* Metrics as two ruled columns: how the patient is responding vs how staff is performing */}
            <div className="grid gap-x-10 sm:grid-cols-2">
              <div className="divide-y divide-aurea-border/60">
                <div className="pb-1 text-[10px] uppercase tracking-[0.1em] text-aurea-ink-3">Patient</div>
                <MeterRow label="Engagement" value={ca.engagement_score} />
                <MeterRow label="Trust" value={ca.trust_score} />
                <MeterRow label="Emotion" value={ca.emotional_score} />
                <MeterRow label="Urgency" value={ca.urgency_score} />
              </div>
              <div className="divide-y divide-aurea-border/60">
                <div className="pb-1 pt-3 text-[10px] uppercase tracking-[0.1em] text-aurea-ink-3 sm:pt-0">Staff delivery</div>
                <MeterRow label="Empathy" value={ca.empathy_level} />
                <MeterRow label="Rapport" value={ca.rapport_building_score} />
                <MeterRow label="Sales Pressure" value={ca.sales_pressure_level} invert />
                {ca.active_listening_score != null && (
                  <MeterRow label="Listening" value={ca.active_listening_score} />
                )}
              </div>
            </div>

            {/* Tone read — compact facts, only when the analyst returned them */}
            {(ca.patient_tone || ca.staff_tone) && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {ca.patient_tone && <FactCell label="Patient tone" value={String(ca.patient_tone)} />}
                {ca.staff_tone && <FactCell label="Staff tone" value={String(ca.staff_tone)} />}
                {ca.tone_alignment && <FactCell label="Alignment" value={String(ca.tone_alignment)} />}
              </div>
            )}

            {/* HIPAA — show the actual issues, not just a count */}
            {ca.compliance_score != null && (
              <div
                className={`rounded-lg border px-3.5 py-2.5 ${
                  ca.compliance_issues?.length > 0
                    ? 'border-aurea-amber/30 bg-aurea-amber/10'
                    : 'border-aurea-border bg-aurea-canvas'
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-[11px] font-medium text-aurea-ink-2">
                    <Shield className="h-3 w-3" strokeWidth={1.75} /> HIPAA Compliance
                  </span>
                  <span className={`aurea-display text-[16px] tabular-nums ${ca.compliance_score < 90 ? 'text-aurea-amber' : 'text-aurea-ink'}`}>
                    {ca.compliance_score}<span className="text-[10px] text-aurea-ink-3">%</span>
                  </span>
                </div>
                {ca.compliance_issues?.length > 0 && (
                  <ul className="mt-2 space-y-1.5">
                    {ca.compliance_issues.map((iss: { issue: string; severity: string }, i: number) => (
                      <li key={i} className="flex items-start gap-2 text-[12px] leading-relaxed text-aurea-ink-2">
                        <span
                          className={`mt-0.5 shrink-0 rounded border px-1 py-px text-[9px] font-medium uppercase tracking-[0.08em] ${
                            iss.severity === 'critical' || iss.severity === 'violation'
                              ? 'border-aurea-rose/30 text-aurea-rose'
                              : 'border-aurea-amber/40 text-aurea-amber'
                          }`}
                        >
                          {iss.severity}
                        </span>
                        <span>{iss.issue}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {ca.coaching_notes && <CoachingNotes text={ca.coaching_notes} />}

            {/* Quick scan: what worked vs what to fix */}
            {(ca.things_done_well?.length > 0 || ca.improvement_areas?.length > 0) && (
              <div className="grid gap-4 border-t border-aurea-border/60 pt-3 sm:grid-cols-2">
                {ca.things_done_well?.length > 0 && (
                  <PointList title="Done Well" items={ca.things_done_well} tone="primary" />
                )}
                {ca.improvement_areas?.length > 0 && (
                  <PointList title="Improve" items={ca.improvement_areas} tone="amber" />
                )}
              </div>
            )}
          </section>
        )}

        {pp && (
          <section className="space-y-2.5">
            <SectionHeading>Patient Psychology</SectionHeading>
            <div className="grid grid-cols-2 gap-3">
              <FactCell label="Personality" value={String(pp.personality_type ?? '—')} />
              <FactCell label="Trust" value={String(pp.trust_level ?? '—').replace(/_/g, ' ')} />
            </div>
            <div className="grid gap-x-10 sm:grid-cols-2">
              <MeterRow label="Anxiety" value={pp.anxiety_level} invert />
              <MeterRow label="Motivation" value={pp.motivation_level} />
            </div>
            {pp.ai_summary && (
              <p className="text-[12.5px] leading-relaxed text-aurea-ink-2">{pp.ai_summary}</p>
            )}
            {pp.next_best_action && (
              <div className="rounded-lg border border-aurea-primary/20 bg-aurea-primary/10 px-3 py-2.5">
                <div className="aurea-eyebrow mb-0.5 !text-aurea-primary">Next Best Action</div>
                <p className="text-[12.5px] leading-relaxed text-aurea-ink-2">{pp.next_best_action}</p>
              </div>
            )}
          </section>
        )}

        {fu && (
          <section className="space-y-2.5">
            <SectionHeading>Tailored Follow-Up Plan</SectionHeading>
            <div className="grid grid-cols-3 gap-3">
              <FactCell label="Channel" value={String(fu.recommended_channel ?? '—')} />
              <FactCell label="Timing" value={String(fu.recommended_timing ?? '—')} />
              <FactCell label="Tone" value={String(fu.recommended_tone ?? '—')} />
            </div>
            {fu.talking_points?.length > 0 && (
              <div className="border-l-2 border-aurea-border-strong py-1 pl-3.5">
                <div className="aurea-eyebrow mb-1">Talking Points</div>
                <ul className="space-y-1 text-[12.5px] leading-relaxed text-aurea-ink-2">
                  {fu.talking_points.map((p: string, i: number) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-aurea-ink-3">&mdash;</span>
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {fu.closing_strategy && (
              <div className="rounded-lg border border-aurea-gold/20 bg-aurea-gold/10 px-3 py-2.5">
                <div className="aurea-eyebrow mb-0.5 !text-aurea-gold">Closing Strategy</div>
                <p className="text-[12.5px] leading-relaxed text-aurea-ink-2">{fu.closing_strategy}</p>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
