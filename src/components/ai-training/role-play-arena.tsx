'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
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

  // ════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════

  // ── History View ──
  if (view === 'history') {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setView('picker')}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
          <h3 className="font-medium">Past Sessions</h3>
        </div>

        {savedSessions.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <History className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No past sessions yet</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {savedSessions.map((s) => (
              <Card
                key={s.id}
                className="cursor-pointer hover:border-primary/30 hover:shadow-sm transition-all"
                onClick={() => handleLoadSession(s.id)}
              >
                <CardContent className="py-3.5 px-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h4 className="font-medium text-sm truncate">{s.title}</h4>
                      <div className="flex items-center gap-2 mt-1.5">
                        <Badge variant="secondary" className="text-[10px] h-5">
                          {s.user_role === 'patient' ? '🧑 Patient' : '💼 TC'}
                        </Badge>
                        <Badge variant="outline" className="text-[10px] h-5">
                          {s.agent_target === 'setter' ? 'Setter' : 'Closer'}
                        </Badge>
                        <Badge
                          variant={s.status === 'active' ? 'default' : 'secondary'}
                          className="text-[10px] h-5"
                        >
                          {s.status}
                        </Badge>
                        {s.extracted_example_count > 0 && (
                          <Badge variant="secondary" className="text-[10px] h-5">
                            {s.extracted_example_count} examples
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
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
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
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
            <ArrowLeft className="h-4 w-4 mr-1" /> New Session
          </Button>
          <h3 className="font-medium">Session Summary</h3>
          <Badge variant="secondary">{messages.length} messages</Badge>
        </div>

        {/* Summary Card */}
        {sessionSummary && (
          <Card className="border-primary/20">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                Training Summary
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap">
                {sessionSummary}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Stats Row */}
        <div className="grid grid-cols-3 gap-3">
          <Card>
            <CardContent className="py-3 flex items-center gap-2">
              <Star className="h-4 w-4 text-amber-500" />
              <div>
                <p className="text-lg font-bold">{goldenCount}</p>
                <p className="text-xs text-muted-foreground">Golden Examples</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-3 flex items-center gap-2">
              <ThumbsUp className="h-4 w-4 text-green-500" />
              <div>
                <p className="text-lg font-bold">{goodCount}</p>
                <p className="text-xs text-muted-foreground">Good Responses</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-3 flex items-center gap-2">
              <ThumbsDown className="h-4 w-4 text-red-500" />
              <div>
                <p className="text-lg font-bold">{badCount}</p>
                <p className="text-xs text-muted-foreground">Needs Work</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Extracted Examples */}
        {extractedExamples.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <FileDown className="h-4 w-4 text-primary" />
                Extracted Training Examples ({extractedExamples.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {extractedExamples.map((ex, i) => (
                <div key={i} className="border rounded-lg p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-[10px]">
                      {ex.category.replace(/_/g, ' ')}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{ex.scenario_context}</span>
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    <div className="bg-blue-50 dark:bg-blue-950/30 rounded p-2">
                      <p className="text-[10px] font-semibold text-blue-600 dark:text-blue-400 mb-0.5">
                        PATIENT
                      </p>
                      <p className="text-xs">{ex.patient_message}</p>
                    </div>
                    <div className="bg-emerald-50 dark:bg-emerald-950/30 rounded p-2">
                      <p className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 mb-0.5">
                        IDEAL RESPONSE
                      </p>
                      <p className="text-xs">{ex.ideal_response}</p>
                    </div>
                  </div>
                  {ex.coaching_notes && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 italic">
                      💡 {ex.coaching_notes}
                    </p>
                  )}
                </div>
              ))}
              <p className="text-xs text-muted-foreground text-center pt-1">
                These examples have been saved as drafts. Approve them in the Memory tab to use in live agent conversations.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Conversation Review */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Conversation Review</CardTitle>
          </CardHeader>
          <CardContent className="max-h-[400px] overflow-y-auto">
            {messages.map((msg, i) => (
              <RolePlayMessage
                key={i}
                message={msg}
                index={i}
                onToggleGolden={() => {}}
                onRate={() => {}}
                onAddNote={() => {}}
              />
            ))}
          </CardContent>
        </Card>
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
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center text-white shadow-sm">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-semibold text-lg">Role Play Arena</h2>
              <p className="text-xs text-muted-foreground">
                Practice conversations to train your AI agents
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => setView('history')}>
            <History className="h-4 w-4 mr-1" />
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
            <div className="flex items-center gap-1.5 mt-0.5">
              <Badge
                variant="secondary"
                className="text-[10px] h-4"
              >
                {activeSession?.user_role === 'patient' ? '🧑 You: Patient' : '💼 You: TC'}
              </Badge>
              <Badge variant="outline" className="text-[10px] h-4">
                Training: {activeSession?.agent_target === 'setter' ? 'Setter' : 'Closer'}
              </Badge>
              {messages.length > 0 && (
                <span className="text-[10px] text-muted-foreground">
                  {messages.length} msgs
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Training stats */}
          {goldenCount > 0 && (
            <Badge variant="secondary" className="gap-1">
              <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
              {goldenCount}
            </Badge>
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
        <div className="bg-muted/50 rounded-lg px-3 py-2 mb-3 text-xs text-muted-foreground border border-muted">
          <span className="font-medium">Scenario:</span> {activeSession.scenario_description}
          {activeSession.patient_persona && (
            <span className="ml-2">
              · Patient: {activeSession.patient_persona.name} ({activeSession.patient_persona.personality_type}, {activeSession.patient_persona.emotional_state})
            </span>
          )}
        </div>
      )}

      {/* Messages */}
      <Card className="flex-1 flex flex-col min-h-0">
        <CardContent className="flex-1 overflow-y-auto py-4 px-4">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-violet-500/20 to-purple-600/20 flex items-center justify-center mb-4">
                <Sparkles className="h-8 w-8 text-violet-500" />
              </div>
              <h3 className="font-semibold text-lg">Ready to Practice!</h3>
              <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                {activeSession?.user_role === 'treatment_coordinator'
                  ? 'You\'re the Treatment Coordinator. Start the conversation — the AI patient is waiting.'
                  : 'You\'re the Patient. Send your first message to test the AI agent.'}
              </p>
              <p className="text-xs text-muted-foreground mt-3 max-w-xs">
                💡 Tip: Star ⭐ great exchanges and rate 👍👎 responses to mark training examples
              </p>
            </div>
          ) : (
            <>
              {messages.map((msg, i) => (
                <RolePlayMessage
                  key={i}
                  message={msg}
                  index={i}
                  onToggleGolden={handleToggleGolden}
                  onRate={handleRate}
                  onAddNote={handleAddNote}
                />
              ))}
              {loading && (
                <div className="flex gap-3 mb-4">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500/20 to-purple-600/20">
                    <Loader2 className="h-4 w-4 animate-spin text-violet-500" />
                  </div>
                  <div className="bg-muted/60 rounded-2xl px-4 py-3 border border-muted">
                    <p className="text-sm text-muted-foreground animate-pulse">
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
        <div className="border-t p-3">
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
          <div className="flex items-center justify-between mt-1.5">
            <p className="text-xs text-muted-foreground">
              Press Cmd+Enter to send
            </p>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Star className="h-3 w-3" /> Star golden examples
              </span>
              <span className="flex items-center gap-1">
                <ThumbsUp className="h-3 w-3" /> Rate responses
              </span>
            </div>
          </div>
        </div>
      </Card>
    </div>
  )
}
