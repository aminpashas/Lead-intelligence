'use client'

import { useState, useRef, useEffect } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
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
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b">
        <div>
          <h3 className="font-medium">
            {lead.first_name} {lead.last_name}
          </h3>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="outline">{conversation.channel}</Badge>
            {conversation.sentiment && (
              <Badge variant="secondary">{conversation.sentiment}</Badge>
            )}
            <span>{messages.length} messages</span>
            <AgentIndicator
              activeAgent={activeAgent}
              conversationId={conversation.id}
              handoffCount={conversation.agent_handoff_count}
              onAgentChange={setActiveAgent}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={analyzeConversation}
            disabled={analyzing || messages.length < 2}
            className="gap-1.5"
          >
            {analyzing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
            Analyze
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={getFollowUpPlan}
            disabled={generatingFollowUp}
            className="gap-1.5"
          >
            {generatingFollowUp ? <Loader2 className="h-3 w-3 animate-spin" /> : <Heart className="h-3 w-3" />}
            Smart Follow-Up
          </Button>
          {(analysisResult || followUpResult) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowInsights(!showInsights)}
              className="gap-1"
            >
              {showInsights ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              Insights
            </Button>
          )}
        </div>
      </div>

      {/* AI Insights Panel */}
      {showInsights && (analysisResult || followUpResult) && (
        <InsightsPanel analysisResult={analysisResult} followUpResult={followUpResult} />
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[75%] rounded-lg px-4 py-2.5 ${
                msg.direction === 'outbound'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted'
              }`}
            >
              {/* Sender indicator */}
              <div className="flex items-center gap-1.5 mb-1">
                {msg.sender_type === 'ai' ? (
                  <Bot className="h-3 w-3" />
                ) : msg.sender_type === 'lead' ? (
                  <User className="h-3 w-3" />
                ) : null}
                <span className="text-xs opacity-70">
                  {msg.sender_type === 'ai' ? 'AI' : msg.sender_name || (msg.direction === 'inbound' ? 'Lead' : 'You')}
                </span>
                {msg.sender_type === 'ai' && msg.metadata && (
                  <AgentMessageLabel agent={(msg.metadata as Record<string, string>).agent} />
                )}
              </div>

              <p className="text-sm whitespace-pre-wrap">{msg.body}</p>

              <div className="flex items-center gap-2 mt-1.5">
                <span className="text-xs opacity-60">
                  {formatDistanceToNow(new Date(msg.created_at), { addSuffix: true })}
                </span>
                {msg.ai_generated && (
                  <Sparkles className="h-3 w-3 opacity-60" />
                )}
                {msg.status === 'failed' && (
                  <Badge variant="destructive" className="text-xs">Failed</Badge>
                )}
              </div>
            </div>
          </div>
        ))}

        {messages.length === 0 && (
          <div className="text-center py-8 text-sm text-muted-foreground">
            No messages yet. Start the conversation below.
          </div>
        )}
      </div>

      {/* Compose */}
      <div className="border-t p-4 space-y-3">
        {/* Agent notes (staff-visible reasoning from the AI) */}
        {agentNotes && (
          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-sm">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600 mt-0.5 shrink-0" />
            <div>
              <span className="font-medium text-amber-800 text-xs">Agent Notes:</span>
              <p className="text-amber-700 text-xs mt-0.5">{agentNotes}</p>
            </div>
          </div>
        )}

        {/* Sales technique tracking display */}
        {(techniquesUsed.length > 0 || leadAssessment) && (
          <div className="p-2.5 rounded-lg bg-blue-50 border border-blue-200 text-xs space-y-2">
            {techniquesUsed.length > 0 && (
              <div>
                <span className="font-medium text-blue-800">Techniques Used:</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {techniquesUsed.map((t, i) => (
                    <span
                      key={i}
                      className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
                        t.effectiveness === 'effective'
                          ? 'bg-green-100 text-green-700'
                          : t.effectiveness === 'backfired'
                            ? 'bg-red-100 text-red-700'
                            : 'bg-gray-100 text-gray-700'
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
              <div className="flex items-center gap-3 text-blue-700">
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
              <Brain className="h-3 w-3" />
            )}
            AI Agent Draft
          </Button>
          <span className="text-xs text-muted-foreground">
            Auto-selects {activeAgent === 'closer' ? 'Closer' : 'Setter'} based on lead stage
          </span>
          {/* Legacy mode selector as fallback */}
          <Select value={aiMode} onValueChange={(v) => v && setAiMode(v)}>
            <SelectTrigger className="w-40 h-7 text-xs">
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
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
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
    <div className="border-b bg-muted/30 p-4 max-h-80 overflow-y-auto space-y-4">
      {ca && (
        <div className="space-y-3">
          <h4 className="text-sm font-semibold flex items-center gap-1.5">
            <Eye className="h-3.5 w-3.5 text-blue-500" />
            Conversation Analysis
          </h4>
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: 'Engagement', value: ca.engagement_score, color: 'text-blue-600' },
              { label: 'Trust', value: ca.trust_score, color: 'text-green-600' },
              { label: 'Emotion', value: ca.emotional_score, color: 'text-pink-600' },
              { label: 'Urgency', value: ca.urgency_score, color: 'text-orange-600' },
            ].map((s) => (
              <div key={s.label} className="bg-background rounded p-2 text-center">
                <div className={`text-lg font-bold ${s.color}`}>{s.value}/10</div>
                <div className="text-xs text-muted-foreground">{s.label}</div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="bg-background rounded p-2">
              <span className="text-muted-foreground">Sales Pressure: </span>
              <span className="font-medium">{ca.sales_pressure_level}/10</span>
            </div>
            <div className="bg-background rounded p-2">
              <span className="text-muted-foreground">Empathy: </span>
              <span className="font-medium">{ca.empathy_level}/10</span>
            </div>
            <div className="bg-background rounded p-2">
              <span className="text-muted-foreground">Rapport: </span>
              <span className="font-medium">{ca.rapport_building_score}/10</span>
            </div>
          </div>
          {ca.coaching_notes && (
            <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded p-3">
              <div className="text-xs font-medium text-blue-700 dark:text-blue-300 mb-1">Coaching Notes</div>
              <p className="text-xs">{ca.coaching_notes}</p>
            </div>
          )}
          {ca.compliance_score != null && (
            <div className="flex items-center gap-2 text-xs">
              <Shield className="h-3 w-3 text-green-500" />
              <span>HIPAA Compliance: {ca.compliance_score}%</span>
              {ca.compliance_issues?.length > 0 && (
                <Badge variant="destructive" className="text-xs">
                  <AlertTriangle className="h-2.5 w-2.5 mr-1" />
                  {ca.compliance_issues.length} issues
                </Badge>
              )}
            </div>
          )}
        </div>
      )}

      {pp && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold flex items-center gap-1.5">
            <Heart className="h-3.5 w-3.5 text-pink-500" />
            Patient Psychology
          </h4>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="bg-background rounded p-2">
              <span className="text-muted-foreground">Personality: </span>
              <span className="font-medium capitalize">{pp.personality_type}</span>
            </div>
            <div className="bg-background rounded p-2">
              <span className="text-muted-foreground">Trust: </span>
              <span className="font-medium capitalize">{String(pp.trust_level).replace(/_/g, ' ')}</span>
            </div>
            <div className="bg-background rounded p-2">
              <span className="text-muted-foreground">Anxiety: </span>
              <span className="font-medium">{pp.anxiety_level}/10</span>
            </div>
            <div className="bg-background rounded p-2">
              <span className="text-muted-foreground">Motivation: </span>
              <span className="font-medium">{pp.motivation_level}/10</span>
            </div>
          </div>
          {pp.ai_summary && (
            <p className="text-xs bg-background rounded p-2 text-muted-foreground">{pp.ai_summary}</p>
          )}
          {pp.next_best_action && (
            <div className="bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded p-2">
              <div className="text-xs font-medium text-green-700 dark:text-green-300">Next Best Action</div>
              <p className="text-xs mt-0.5">{pp.next_best_action}</p>
            </div>
          )}
        </div>
      )}

      {fu && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold flex items-center gap-1.5">
            <Heart className="h-3.5 w-3.5 text-pink-500" />
            Tailored Follow-Up Plan
          </h4>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="bg-background rounded p-2">
              <span className="text-muted-foreground">Channel: </span>
              <span className="font-medium capitalize">{fu.recommended_channel}</span>
            </div>
            <div className="bg-background rounded p-2">
              <span className="text-muted-foreground">Timing: </span>
              <span className="font-medium">{fu.recommended_timing}</span>
            </div>
            <div className="bg-background rounded p-2">
              <span className="text-muted-foreground">Tone: </span>
              <span className="font-medium capitalize">{fu.recommended_tone}</span>
            </div>
          </div>
          {fu.talking_points?.length > 0 && (
            <div className="bg-background rounded p-2">
              <div className="text-xs font-medium mb-1">Talking Points</div>
              <ul className="text-xs text-muted-foreground space-y-0.5">
                {fu.talking_points.map((p: string, i: number) => (
                  <li key={i}>&bull; {p}</li>
                ))}
              </ul>
            </div>
          )}
          {fu.closing_strategy && (
            <div className="bg-purple-50 dark:bg-purple-950/30 border border-purple-200 dark:border-purple-800 rounded p-2">
              <div className="text-xs font-medium text-purple-700 dark:text-purple-300">Closing Strategy</div>
              <p className="text-xs mt-0.5">{fu.closing_strategy}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
