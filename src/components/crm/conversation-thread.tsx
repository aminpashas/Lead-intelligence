'use client'

import { useState, useRef, useEffect } from 'react'
import { formatDistanceToNow } from 'date-fns'
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
  Shield,
  AlertTriangle,
} from 'lucide-react'
import { toast } from 'sonner'
import type { Conversation, Message, Lead, AgentType } from '@/types/database'
import { AgentIndicator, AgentMessageLabel } from './agent-indicator'
import { AIModeToggle } from './ai-mode-toggle'

export function ConversationThread({
  lead,
  conversation,
  messages: initialMessages,
}: {
  lead: Lead
  conversation: Conversation
  messages: Message[]
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

  return (
    <div className="flex h-full flex-col">
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-aurea-border px-5 py-4">
        <div>
          <h3 className="text-[15px] font-medium text-aurea-ink">
            {lead.first_name} {lead.last_name}
          </h3>
          <div className="mt-1 flex items-center gap-2">
            <span className="inline-flex items-center rounded border border-aurea-border px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-aurea-ink-3">
              {conversation.channel}
            </span>
            {conversation.sentiment && (
              <span className="inline-flex items-center rounded border border-aurea-border px-2 py-0.5 text-[11px] text-aurea-ink-3 capitalize">
                {conversation.sentiment}
              </span>
            )}
            <span className="text-[12px] text-aurea-ink-3">{messages.length} messages</span>
            <AgentIndicator
              activeAgent={activeAgent}
              conversationId={conversation.id}
              handoffCount={conversation.agent_handoff_count}
              onAgentChange={setActiveAgent}
            />
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* AI Mode Toggle */}
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
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-5">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[75%] rounded-lg px-4 py-2.5 ${
                msg.direction === 'outbound'
                  ? 'bg-aurea-primary text-white'
                  : 'border border-aurea-border bg-aurea-surface-2 text-aurea-ink'
              }`}
            >
              {/* Sender indicator */}
              <div className="mb-1 flex items-center gap-1.5">
                {msg.sender_type === 'ai' ? (
                  <Bot className="h-3 w-3" strokeWidth={1.75} />
                ) : msg.sender_type === 'lead' ? (
                  <User className="h-3 w-3" strokeWidth={1.75} />
                ) : null}
                <span className="text-xs opacity-70">
                  {msg.sender_type === 'ai' ? 'AI' : msg.sender_name || (msg.direction === 'inbound' ? 'Lead' : 'You')}
                </span>
                {msg.sender_type === 'ai' && msg.metadata && (
                  <AgentMessageLabel agent={(msg.metadata as Record<string, string>).agent} />
                )}
              </div>

              <p className="whitespace-pre-wrap text-sm">{msg.body}</p>

              <div className="mt-1.5 flex items-center gap-2">
                <span className="text-xs opacity-60">
                  {formatDistanceToNow(new Date(msg.created_at), { addSuffix: true })}
                </span>
                {msg.ai_generated && (
                  <Sparkles className="h-3 w-3 opacity-60" strokeWidth={1.75} />
                )}
                {msg.status === 'failed' && (
                  <span className="rounded border border-aurea-rose/30 bg-aurea-rose/10 px-1.5 py-0.5 text-[10px] font-medium text-aurea-rose">
                    Failed
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}

        {messages.length === 0 && (
          <div className="py-8 text-center text-[13px] text-aurea-ink-3">
            No messages yet. Start the conversation below.
          </div>
        )}
      </div>

      {/* ── Compose ────────────────────────────────────────── */}
      <div className="space-y-3 border-t border-aurea-border p-5">
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

        {/* AI Generate */}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={generateAIMessage}
            disabled={generating}
            className="gap-1.5"
          >
            {generating ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Brain className="h-3 w-3" strokeWidth={1.75} />
            )}
            AI Agent Draft
          </Button>
          <span className="text-xs text-aurea-ink-3">
            Auto-selects {activeAgent === 'closer' ? 'Closer' : 'Setter'} based on lead stage
          </span>
          {/* Legacy mode selector as fallback */}
          <Select value={aiMode} onValueChange={(v) => v && setAiMode(v)}>
            <SelectTrigger className="h-7 w-40 text-xs">
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

        {/* Message input */}
        <div className="flex gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              conversation.channel === 'sms'
                ? 'Type an SMS message...'
                : 'Type an email message...'
            }
            rows={3}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                handleSend()
              }
            }}
          />
          <Button
            onClick={handleSend}
            disabled={sending || !draft.trim()}
            className="self-end"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" strokeWidth={1.75} />
            )}
          </Button>
        </div>
        <p className="text-xs text-aurea-ink-3">
          Press Cmd+Enter to send
        </p>
      </div>
    </div>
  )
}

// ── Insights Panel Component ────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function InsightsPanel({ analysisResult, followUpResult }: { analysisResult: any; followUpResult: any }) {
  const ca = analysisResult?.conversation_analysis
  const pp = analysisResult?.patient_profile
  const fu = followUpResult?.follow_up

  return (
    <div className="max-h-80 space-y-4 overflow-y-auto border-b border-aurea-border bg-aurea-surface p-5">
      {ca && (
        <div className="space-y-3">
          <h4 className="flex items-center gap-1.5 text-[13px] font-semibold text-aurea-ink">
            <Eye className="h-3.5 w-3.5 text-aurea-primary" strokeWidth={1.75} />
            Conversation Analysis
          </h4>
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: 'Engagement', value: ca.engagement_score, accent: 'text-aurea-primary' },
              { label: 'Trust', value: ca.trust_score, accent: 'text-aurea-primary' },
              { label: 'Emotion', value: ca.emotional_score, accent: 'text-aurea-rose' },
              { label: 'Urgency', value: ca.urgency_score, accent: 'text-aurea-amber' },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border border-aurea-border bg-aurea-canvas p-2 text-center">
                <div className={`aurea-display text-[18px] tabular-nums ${s.accent}`}>{s.value}/10</div>
                <div className="text-[11px] text-aurea-ink-3">{s.label}</div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="rounded-lg border border-aurea-border bg-aurea-canvas p-2">
              <span className="text-aurea-ink-3">Sales Pressure: </span>
              <span className="font-medium text-aurea-ink">{ca.sales_pressure_level}/10</span>
            </div>
            <div className="rounded-lg border border-aurea-border bg-aurea-canvas p-2">
              <span className="text-aurea-ink-3">Empathy: </span>
              <span className="font-medium text-aurea-ink">{ca.empathy_level}/10</span>
            </div>
            <div className="rounded-lg border border-aurea-border bg-aurea-canvas p-2">
              <span className="text-aurea-ink-3">Rapport: </span>
              <span className="font-medium text-aurea-ink">{ca.rapport_building_score}/10</span>
            </div>
          </div>
          {ca.coaching_notes && (
            <div className="rounded-lg border border-aurea-border bg-aurea-surface-2 p-3">
              <div className="mb-1 text-[11px] font-medium text-aurea-ink">Coaching Notes</div>
              <p className="text-xs text-aurea-ink-2">{ca.coaching_notes}</p>
            </div>
          )}
          {ca.compliance_score != null && (
            <div className="flex items-center gap-2 text-xs">
              <Shield className="h-3 w-3 text-aurea-primary" strokeWidth={1.75} />
              <span className="text-aurea-ink-2">HIPAA Compliance: {ca.compliance_score}%</span>
              {ca.compliance_issues?.length > 0 && (
                <span className="inline-flex items-center gap-1 rounded border border-aurea-rose/30 bg-aurea-rose/10 px-1.5 py-0.5 text-[10px] font-medium text-aurea-rose">
                  <AlertTriangle className="h-2.5 w-2.5" strokeWidth={1.75} />
                  {ca.compliance_issues.length} issues
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {pp && (
        <div className="space-y-2">
          <h4 className="flex items-center gap-1.5 text-[13px] font-semibold text-aurea-ink">
            <Heart className="h-3.5 w-3.5 text-aurea-rose" strokeWidth={1.75} />
            Patient Psychology
          </h4>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg border border-aurea-border bg-aurea-canvas p-2">
              <span className="text-aurea-ink-3">Personality: </span>
              <span className="font-medium capitalize text-aurea-ink">{pp.personality_type}</span>
            </div>
            <div className="rounded-lg border border-aurea-border bg-aurea-canvas p-2">
              <span className="text-aurea-ink-3">Trust: </span>
              <span className="font-medium capitalize text-aurea-ink">{String(pp.trust_level).replace(/_/g, ' ')}</span>
            </div>
            <div className="rounded-lg border border-aurea-border bg-aurea-canvas p-2">
              <span className="text-aurea-ink-3">Anxiety: </span>
              <span className="font-medium text-aurea-ink">{pp.anxiety_level}/10</span>
            </div>
            <div className="rounded-lg border border-aurea-border bg-aurea-canvas p-2">
              <span className="text-aurea-ink-3">Motivation: </span>
              <span className="font-medium text-aurea-ink">{pp.motivation_level}/10</span>
            </div>
          </div>
          {pp.ai_summary && (
            <p className="rounded-lg border border-aurea-border bg-aurea-canvas p-2 text-xs text-aurea-ink-2">{pp.ai_summary}</p>
          )}
          {pp.next_best_action && (
            <div className="rounded-lg border border-aurea-primary/20 bg-aurea-primary/10 p-2">
              <div className="text-[11px] font-medium text-aurea-primary">Next Best Action</div>
              <p className="mt-0.5 text-xs text-aurea-ink-2">{pp.next_best_action}</p>
            </div>
          )}
        </div>
      )}

      {fu && (
        <div className="space-y-2">
          <h4 className="flex items-center gap-1.5 text-[13px] font-semibold text-aurea-ink">
            <Heart className="h-3.5 w-3.5 text-aurea-rose" strokeWidth={1.75} />
            Tailored Follow-Up Plan
          </h4>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="rounded-lg border border-aurea-border bg-aurea-canvas p-2">
              <span className="text-aurea-ink-3">Channel: </span>
              <span className="font-medium capitalize text-aurea-ink">{fu.recommended_channel}</span>
            </div>
            <div className="rounded-lg border border-aurea-border bg-aurea-canvas p-2">
              <span className="text-aurea-ink-3">Timing: </span>
              <span className="font-medium text-aurea-ink">{fu.recommended_timing}</span>
            </div>
            <div className="rounded-lg border border-aurea-border bg-aurea-canvas p-2">
              <span className="text-aurea-ink-3">Tone: </span>
              <span className="font-medium capitalize text-aurea-ink">{fu.recommended_tone}</span>
            </div>
          </div>
          {fu.talking_points?.length > 0 && (
            <div className="rounded-lg border border-aurea-border bg-aurea-canvas p-2">
              <div className="mb-1 text-[11px] font-medium text-aurea-ink">Talking Points</div>
              <ul className="space-y-0.5 text-xs text-aurea-ink-2">
                {fu.talking_points.map((p: string, i: number) => (
                  <li key={i}>&bull; {p}</li>
                ))}
              </ul>
            </div>
          )}
          {fu.closing_strategy && (
            <div className="rounded-lg border border-aurea-gold/20 bg-aurea-gold/10 p-2">
              <div className="text-[11px] font-medium text-aurea-gold">Closing Strategy</div>
              <p className="mt-0.5 text-xs text-aurea-ink-2">{fu.closing_strategy}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
