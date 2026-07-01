'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import {
  Send,
  Loader2,
  SquareIcon,
  Trash2,
  Sparkles,
  FileDown,
  History,
  ArrowLeft,
  Star,
  ThumbsUp,
  ThumbsDown,
  Check,
  X,
  RotateCcw,
} from 'lucide-react'
import { RolePlayMessage } from './role-play-message'
import { RolePlayScenarioPicker } from './role-play-scenario-picker'
import { toast } from 'sonner'
import type {
  AIRolePlayMessage,
  AIRolePlaySession,
  RolePlayRole,
  RolePlayAgentTarget,
} from '@/types/database'

type SessionListItem = {
  id: string
  title: string
  user_role: RolePlayRole
  agent_target: RolePlayAgentTarget
  scenario_description: string | null
  status: string
  overall_rating: number | null
  extracted_example_count: number
  created_at: string
}

type ExtractedExample = {
  category: string
  scenario_context: string
  patient_message: string
  ideal_response: string
  coaching_notes: string | null
}

export function RolePlayArena() {
  // Views: 'picker' | 'session' | 'history' | 'summary'
  const [view, setView] = useState<'picker' | 'session' | 'history' | 'summary'>('picker')
  const [activeSession, setActiveSession] = useState<AIRolePlaySession | null>(null)
  const [messages, setMessages] = useState<AIRolePlayMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [savedSessions, setSavedSessions] = useState<SessionListItem[]>([])
  const [extracting, setExtracting] = useState(false)
  const [sessionSummary, setSessionSummary] = useState<string | null>(null)
  const [extractedExamples, setExtractedExamples] = useState<ExtractedExample[]>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [retryingIndex, setRetryingIndex] = useState<number | null>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/ai/training/roleplay')
      const data = await res.json()
      setSavedSessions(data.sessions || [])
    } catch {
      // Silent fail
    }
  }, [])

  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  // ── Start a new session ──
  async function handleStartSession(config: {
    title: string
    user_role: RolePlayRole
    agent_target: RolePlayAgentTarget
    scenario_id: string | null
    scenario_description: string | null
    patient_persona: AIRolePlaySession['patient_persona'] | null
  }) {
    try {
      const res = await fetch('/api/ai/training/roleplay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to create session')
      }

      const data = await res.json()
      setActiveSession(data.session)
      setMessages([])
      setSessionSummary(null)
      setExtractedExamples([])
      setView('session')
      toast.success('Role play session started!')
      textareaRef.current?.focus()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start session')
    }
  }

  // ── Send message ──
  async function sendMessage() {
    if (!input.trim() || loading || !activeSession) return

    setLoading(true)
    const messageContent = input.trim()
    setInput('')

    // Optimistically add user message
    const optimisticUserMsg: AIRolePlayMessage = {
      role: 'user',
      content: messageContent,
      timestamp: new Date().toISOString(),
      is_golden_example: false,
      rating: null,
      coaching_note: null,
      acting_as: activeSession.user_role,
      is_finalized: false,
      retry_count: 0,
      previous_attempts: [],
    }
    setMessages((prev) => [...prev, optimisticUserMsg])

    try {
      const res = await fetch('/api/ai/training/roleplay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: activeSession.id,
          content: messageContent,
        }),
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to get response')
      }

      const data = await res.json()
      setMessages((prev) => [...prev, data.ai_message])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to get AI response')
      // Remove optimistic message on error
      setMessages((prev) => prev.slice(0, -1))
      setInput(messageContent)
    } finally {
      setLoading(false)
      textareaRef.current?.focus()
    }
  }

  // ── Training controls ──
  function handleToggleGolden(index: number) {
    setMessages((prev) =>
      prev.map((m, i) =>
        i === index ? { ...m, is_golden_example: !m.is_golden_example } : m
      )
    )
    // Persist to server
    if (activeSession) {
      const updated = messages.map((m, i) =>
        i === index ? { ...m, is_golden_example: !m.is_golden_example } : m
      )
      fetch(`/api/ai/training/roleplay/${activeSession.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: updated }),
      })
    }
  }

  function handleRate(index: number, rating: 'good' | 'bad' | null) {
    setMessages((prev) =>
      prev.map((m, i) => (i === index ? { ...m, rating } : m))
    )
    if (activeSession) {
      const updated = messages.map((m, i) => (i === index ? { ...m, rating } : m))
      fetch(`/api/ai/training/roleplay/${activeSession.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: updated }),
      })
    }
  }

  function handleAddNote(index: number, note: string) {
    setMessages((prev) =>
      prev.map((m, i) => (i === index ? { ...m, coaching_note: note || null } : m))
    )
    if (activeSession) {
      const updated = messages.map((m, i) =>
        i === index ? { ...m, coaching_note: note || null } : m
      )
      fetch(`/api/ai/training/roleplay/${activeSession.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: updated }),
      })
    }
  }

  // ── Retry / Course Correct ──
  async function handleRetry(index: number, feedback: string | null) {
    if (!activeSession || retryingIndex !== null) return

    setRetryingIndex(index)
    try {
      const res = await fetch('/api/ai/training/roleplay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: activeSession.id,
          retry: true,
          message_index: index,
          feedback,
        }),
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Retry failed')
      }

      const data = await res.json()
      // Replace the message at the index
      setMessages((prev) =>
        prev.map((m, i) => (i === data.message_index ? data.updated_message : m))
      )
      toast.success(
        feedback ? 'Response regenerated with your feedback!' : 'Response regenerated!'
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to retry')
    } finally {
      setRetryingIndex(null)
    }
  }

  // ── Finalize / Accept ──
  function handleFinalize(index: number) {
    setMessages((prev) =>
      prev.map((m, i) =>
        i === index
          ? { ...m, is_finalized: true, is_golden_example: true, rating: 'good' as const }
          : m
      )
    )
    if (activeSession) {
      const updated = messages.map((m, i) =>
        i === index
          ? { ...m, is_finalized: true, is_golden_example: true, rating: 'good' as const }
          : m
      )
      fetch(`/api/ai/training/roleplay/${activeSession.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: updated }),
      })
    }
    toast.success('Response accepted and marked as golden example! ✅')
  }

  // ── End session & extract ──
  async function handleEndSession() {
    if (!activeSession) return

    // Save final messages first
    await fetch(`/api/ai/training/roleplay/${activeSession.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    })

    setExtracting(true)
    try {
      const res = await fetch(`/api/ai/training/roleplay/${activeSession.id}/extract`, {
        method: 'POST',
      })

      if (!res.ok) throw new Error('Extraction failed')

      const data = await res.json()
      setSessionSummary(data.summary)
      setExtractedExamples(data.examples || [])
      setView('summary')
      toast.success(`Extracted ${data.example_count} training examples!`)
      fetchSessions()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to extract training')
    } finally {
      setExtracting(false)
    }
  }

  // ── Load a saved session ──
  async function handleLoadSession(id: string) {
    try {
      const res = await fetch(`/api/ai/training/roleplay/${id}`)
      const data = await res.json()
      if (data.session) {
        setActiveSession(data.session)
        setMessages(data.session.messages || [])
        setSessionSummary(data.session.session_summary)
        setView(data.session.status === 'active' ? 'session' : 'summary')
      }
    } catch {
      toast.error('Failed to load session')
    }
  }

  async function handleDeleteSession(id: string) {
    try {
      await fetch(`/api/ai/training/roleplay/${id}`, { method: 'DELETE' })
      setSavedSessions((prev) => prev.filter((s) => s.id !== id))
      toast.success('Session deleted')
    } catch {
      toast.error('Failed to delete session')
    }
  }

  // ── Stats ──
  const goldenCount = messages.filter((m) => m.is_golden_example).length
  const goodCount = messages.filter((m) => m.rating === 'good').length
  const badCount = messages.filter((m) => m.rating === 'bad').length
  const finalizedCount = messages.filter((m) => m.is_finalized).length

  // Find the last assistant message index
  const lastAssistantIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return i
    }
    return -1
  })()

  // ════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════

  // ── History View ──
  if (view === 'history') {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setView('picker')}>
            <ArrowLeft className="h-4 w-4 mr-1" strokeWidth={1.75} /> Back
          </Button>
          <h3 className="aurea-display text-[18px] text-aurea-ink">Past Sessions</h3>
        </div>

        {savedSessions.length === 0 ? (
          <div className="aurea-card py-12 text-center">
            <History className="h-10 w-10 text-aurea-ink-3/30 mx-auto mb-3" strokeWidth={1.75} />
            <p className="text-[13px] text-aurea-ink-3">No past sessions yet</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {savedSessions.map((s) => (
              <div
                key={s.id}
                className="aurea-card cursor-pointer px-4 py-3.5 transition-colors hover:bg-aurea-surface-2"
                onClick={() => handleLoadSession(s.id)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h4 className="text-[14px] font-medium text-aurea-ink truncate">{s.title}</h4>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <span className="inline-flex items-center rounded border border-aurea-border px-2 py-0.5 text-[10px] text-aurea-ink-3">
                        {s.user_role === 'patient' ? '🧑 Patient' : '💼 TC'}
                      </span>
                      <span className="inline-flex items-center rounded border border-aurea-border px-2 py-0.5 text-[10px] text-aurea-ink-3">
                        {s.agent_target === 'setter' ? 'Setter' : 'Closer'}
                      </span>
                      <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-medium ${s.status === 'active' ? 'border-aurea-primary/20 bg-aurea-primary/10 text-aurea-primary' : 'border-aurea-border bg-aurea-surface-2 text-aurea-ink-3'}`}>
                        {s.status}
                      </span>
                      {s.extracted_example_count > 0 && (
                        <span className="inline-flex items-center rounded border border-aurea-border px-2 py-0.5 font-mono text-[10px] tabular-nums text-aurea-ink-3">
                          {s.extracted_example_count} examples
                        </span>
                      )}
                    </div>
                    <p className="mt-1 font-mono text-[11px] tabular-nums text-aurea-ink-3">
                      {new Date(s.created_at).toLocaleDateString()} at{' '}
                      {new Date(s.created_at).toLocaleTimeString()}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 shrink-0"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDeleteSession(s.id)
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-aurea-ink-3" strokeWidth={1.75} />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ── Summary View ──
  if (view === 'summary') {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setView('picker')}>
            <ArrowLeft className="h-4 w-4 mr-1" strokeWidth={1.75} /> New Session
          </Button>
          <h3 className="aurea-display text-[18px] text-aurea-ink">Session Summary</h3>
          <span className="font-mono text-[12px] tabular-nums text-aurea-ink-3">{messages.length} messages</span>
        </div>

        {/* Summary Card */}
        {sessionSummary && (
          <div className="aurea-card overflow-hidden">
            <div className="flex items-center gap-2 border-b border-aurea-border px-4 py-3">
              <Sparkles className="h-4 w-4 text-aurea-primary" strokeWidth={1.75} />
              <h4 className="aurea-display text-[15px] text-aurea-ink">Training Summary</h4>
            </div>
            <div className="p-4">
              <div className="whitespace-pre-wrap text-[13px] text-aurea-ink-2">
                {sessionSummary}
              </div>
            </div>
          </div>
        )}

        {/* Stats Row */}
        <div className="grid grid-cols-3 gap-3">
          <div className="aurea-card flex items-center gap-3 p-4">
            <Star className="h-4 w-4 text-aurea-amber" strokeWidth={1.75} />
            <div>
              <p className="aurea-display text-[22px] tabular-nums text-aurea-ink">{goldenCount}</p>
              <p className="text-[11px] text-aurea-ink-3">Golden Examples</p>
            </div>
          </div>
          <div className="aurea-card flex items-center gap-3 p-4">
            <ThumbsUp className="h-4 w-4 text-aurea-primary" strokeWidth={1.75} />
            <div>
              <p className="aurea-display text-[22px] tabular-nums text-aurea-ink">{goodCount}</p>
              <p className="text-[11px] text-aurea-ink-3">Good Responses</p>
            </div>
          </div>
          <div className="aurea-card flex items-center gap-3 p-4">
            <ThumbsDown className="h-4 w-4 text-aurea-rose" strokeWidth={1.75} />
            <div>
              <p className="aurea-display text-[22px] tabular-nums text-aurea-ink">{badCount}</p>
              <p className="text-[11px] text-aurea-ink-3">Needs Work</p>
            </div>
          </div>
        </div>

        {/* Extracted Examples */}
        {extractedExamples.length > 0 && (
          <div className="aurea-card overflow-hidden">
            <div className="flex items-center gap-2 border-b border-aurea-border px-4 py-3">
              <FileDown className="h-4 w-4 text-aurea-primary" strokeWidth={1.75} />
              <h4 className="aurea-display text-[15px] text-aurea-ink">
                Extracted Training Examples ({extractedExamples.length})
              </h4>
            </div>
            <div className="space-y-3 p-4">
              {extractedExamples.map((ex, i) => (
                <div key={i} className="rounded-lg border border-aurea-border p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center rounded border border-aurea-border px-2 py-0.5 text-[10px] text-aurea-ink-3">
                      {ex.category.replace(/_/g, ' ')}
                    </span>
                    <span className="text-[11px] text-aurea-ink-3">{ex.scenario_context}</span>
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    <div className="rounded bg-aurea-surface-2 border border-aurea-border p-2">
                      <p className="aurea-eyebrow mb-0.5 text-[10px]">PATIENT</p>
                      <p className="text-[12px] text-aurea-ink-2">{ex.patient_message}</p>
                    </div>
                    <div className="rounded bg-aurea-primary/10 border border-aurea-primary/20 p-2">
                      <p className="aurea-eyebrow mb-0.5 text-[10px] text-aurea-primary">IDEAL RESPONSE</p>
                      <p className="text-[12px] text-aurea-ink-2">{ex.ideal_response}</p>
                    </div>
                  </div>
                  {ex.coaching_notes && (
                    <p className="text-[12px] text-aurea-amber italic">
                      {ex.coaching_notes}
                    </p>
                  )}
                </div>
              ))}
              <p className="pt-1 text-center text-[12px] text-aurea-ink-3">
                These examples have been saved as drafts. Approve them in the Memory tab to use in live agent conversations.
              </p>
            </div>
          </div>
        )}

        {/* Conversation Review */}
        <div className="aurea-card overflow-hidden">
          <div className="border-b border-aurea-border px-4 py-3">
            <h4 className="aurea-display text-[15px] text-aurea-ink">Conversation Review</h4>
          </div>
          <div className="max-h-[400px] overflow-y-auto p-4">
            {messages.map((msg, i) => (
              <RolePlayMessage
                key={i}
                message={msg}
                index={i}
                isLastAssistantMessage={false}
                isRetrying={false}
                onToggleGolden={() => {}}
                onRate={() => {}}
                onAddNote={() => {}}
                onRetry={() => {}}
                onFinalize={() => {}}
              />
            ))}
          </div>
        </div>
      </div>
    )
  }

  // ── Scenario Picker View ──
  if (view === 'picker') {
    return (
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-aurea-border bg-aurea-surface-2">
              <Sparkles className="h-5 w-5 text-aurea-primary" strokeWidth={1.75} />
            </div>
            <div>
              <h2 className="aurea-display text-[18px] text-aurea-ink">Role Play Arena</h2>
              <p className="text-[12px] text-aurea-ink-3">
                Practice conversations to train your AI agents
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => setView('history')}>
            <History className="h-4 w-4 mr-1" strokeWidth={1.75} />
            Past Sessions ({savedSessions.length})
          </Button>
        </div>

        <RolePlayScenarioPicker onStart={handleStartSession} />
      </div>
    )
  }

  // ── Active Session View ──
  return (
    <div className="flex flex-col h-[calc(100vh-280px)]">
      {/* Session Header */}
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setView('picker')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h3 className="font-medium text-sm">{activeSession?.title || 'Role Play'}</h3>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className="inline-flex items-center rounded border border-aurea-border px-2 py-0.5 text-[10px] text-aurea-ink-3">
                {activeSession?.user_role === 'patient' ? '🧑 You: Patient' : '💼 You: TC'}
              </span>
              <span className="inline-flex items-center rounded border border-aurea-border px-2 py-0.5 text-[10px] text-aurea-ink-3">
                Training: {activeSession?.agent_target === 'setter' ? 'Setter' : 'Closer'}
              </span>
              {messages.length > 0 && (
                <span className="font-mono text-[10px] tabular-nums text-aurea-ink-3">
                  {messages.length} msgs
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Training stats */}
          {finalizedCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded border border-aurea-primary/20 bg-aurea-primary/10 px-2 py-0.5 font-mono text-[10px] tabular-nums text-aurea-primary">
              <Check className="h-3 w-3" strokeWidth={1.75} />
              {finalizedCount} accepted
            </span>
          )}
          {goldenCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded border border-aurea-amber/20 bg-aurea-amber/10 px-2 py-0.5 font-mono text-[10px] tabular-nums text-aurea-amber">
              <Star className="h-3 w-3 fill-current" strokeWidth={1.75} />
              {goldenCount}
            </span>
          )}
          <Button
            variant="destructive"
            size="sm"
            onClick={handleEndSession}
            disabled={messages.length < 2 || extracting}
          >
            {extracting ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                Extracting...
              </>
            ) : (
              <>
                <SquareIcon className="h-3.5 w-3.5 mr-1" />
                End & Extract
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Scenario Context Bar */}
      {activeSession?.scenario_description && (
        <div className="mb-3 rounded-lg border border-aurea-border bg-aurea-surface-2 px-3 py-2 text-[12px] text-aurea-ink-3">
          <span className="font-medium text-aurea-ink-2">Scenario:</span> {activeSession.scenario_description}
          {activeSession.patient_persona && (
            <span className="ml-2">
              &middot; Patient: {activeSession.patient_persona.name} ({activeSession.patient_persona.personality_type}, {activeSession.patient_persona.emotional_state})
            </span>
          )}
        </div>
      )}

      {/* Messages */}
      <Card className="flex-1 flex flex-col min-h-0">
        <CardContent className="flex-1 overflow-y-auto py-4 px-4">
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-aurea-border bg-aurea-surface-2">
                <Sparkles className="h-8 w-8 text-aurea-primary" strokeWidth={1.75} />
              </div>
              <h3 className="aurea-display text-[20px] text-aurea-ink">Ready to Practice!</h3>
              <p className="mt-1 max-w-sm text-[13px] text-aurea-ink-2">
                {activeSession?.user_role === 'treatment_coordinator'
                  ? 'You\'re the Treatment Coordinator. Start the conversation — the AI patient is waiting.'
                  : 'You\'re the Patient. Send your first message to test the AI agent.'}
              </p>
              <p className="mt-3 max-w-xs text-[12px] text-aurea-ink-3">
                Tip: After each AI response, you can Accept, Retry, or Course Correct until you&apos;re happy with it.
              </p>
            </div>
          ) : (
            <>
              {messages.map((msg, i) => (
                <RolePlayMessage
                  key={`${i}-${msg.retry_count || 0}`}
                  message={msg}
                  index={i}
                  isLastAssistantMessage={i === lastAssistantIndex}
                  isRetrying={retryingIndex === i}
                  onToggleGolden={handleToggleGolden}
                  onRate={handleRate}
                  onAddNote={handleAddNote}
                  onRetry={handleRetry}
                  onFinalize={handleFinalize}
                />
              ))}
              {loading && (
                <div className="mb-4 flex gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-aurea-border bg-aurea-surface-2">
                    <Loader2 className="h-4 w-4 animate-spin text-aurea-ink-3" strokeWidth={1.75} />
                  </div>
                  <div className="rounded-2xl border border-aurea-border bg-aurea-surface-2 px-4 py-3">
                    <p className="animate-pulse text-[13px] text-aurea-ink-3">
                      {activeSession?.user_role === 'treatment_coordinator'
                        ? 'Patient is typing...'
                        : 'TC is composing a response...'}
                    </p>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )}
        </CardContent>

        {/* Input Area */}
        <div className="border-t border-aurea-border p-3">
          <div className="flex gap-2">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                activeSession?.user_role === 'treatment_coordinator'
                  ? 'Respond as the Treatment Coordinator...'
                  : 'Send a message as the Patient...'
              }
              rows={2}
              className="resize-none"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  sendMessage()
                }
              }}
            />
            <Button
              onClick={sendMessage}
              disabled={loading || !input.trim()}
              className="self-end"
              size="default"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
          <div className="mt-1.5 flex items-center justify-between">
            <p className="text-[12px] text-aurea-ink-3">
              Press Cmd+Enter to send
            </p>
            <div className="flex items-center gap-3 text-[12px] text-aurea-ink-3">
              <span className="flex items-center gap-1">
                <Check className="h-3 w-3" strokeWidth={1.75} /> Accept responses
              </span>
              <span className="flex items-center gap-1">
                <RotateCcw className="h-3 w-3" strokeWidth={1.75} /> Retry or course correct
              </span>
            </div>
          </div>
        </div>
      </Card>
    </div>
  )
}
