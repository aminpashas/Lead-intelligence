'use client'

import { useState, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
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
  Loader2,
  RotateCcw,
  Save,
  ChevronDown,
  ChevronUp,
  History,
  Trash2,
  Sparkles,
} from 'lucide-react'
import { ChatMessage } from './chat-message'
import { toast } from 'sonner'
import type { AITestConversation, AITestMessage } from '@/types/database'

const MODES = [
  { value: 'general', label: 'General Assistant' },
  { value: 'lead_engagement', label: 'Lead Engagement' },
  { value: 'objection_handling', label: 'Objection Handling' },
  { value: 'appointment_scheduling', label: 'Appointment Scheduling' },
  { value: 'education', label: 'Patient Education' },
  { value: 'follow_up', label: 'Follow-Up' },
]

export function ChatPlayground() {
  const [messages, setMessages] = useState<AITestMessage[]>([])
  const [input, setInput] = useState('')
  const [mode, setMode] = useState('general')
  const [loading, setLoading] = useState(false)
  const [showSystemPrompt, setShowSystemPrompt] = useState(false)
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null)
  const [memoriesUsed, setMemoriesUsed] = useState<string[]>([])
  const [articlesUsed, setArticlesUsed] = useState<{ id: string; title: string }[]>([])
  const [savedConversations, setSavedConversations] = useState<AITestConversation[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    fetchSavedConversations()
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function fetchSavedConversations() {
    try {
      const res = await fetch('/api/ai/training/conversations')
      const data = await res.json()
      setSavedConversations(data.conversations || [])
    } catch {
      toast.error('Failed to load saved conversations')
    }
  }

  async function sendMessage() {
    if (!input.trim() || loading) return

    const userMessage: AITestMessage = {
      role: 'user',
      content: input.trim(),
      timestamp: new Date().toISOString(),
    }

    const updatedMessages = [...messages, userMessage]
    setMessages(updatedMessages)
    setInput('')
    setLoading(true)

    try {
      const res = await fetch('/api/ai/training/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: updatedMessages.map((m) => ({ role: m.role, content: m.content })),
          mode,
        }),
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to get response')
      }

      const data = await res.json()

      const assistantMessage: AITestMessage = {
        role: 'assistant',
        content: data.response,
        timestamp: new Date().toISOString(),
      }

      setMessages([...updatedMessages, assistantMessage])
      setSystemPrompt(data.system_prompt_used)
      setMemoriesUsed(data.memories_used || [])
      setArticlesUsed(data.articles_used || [])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to get AI response')
      // Remove the user message on error
      setMessages(messages)
    } finally {
      setLoading(false)
      textareaRef.current?.focus()
    }
  }

  function handleNewConversation() {
    setMessages([])
    setSystemPrompt(null)
    setMemoriesUsed([])
    setArticlesUsed([])
    setInput('')
  }

  async function handleSave() {
    if (messages.length === 0) return

    const title = `${MODES.find((m) => m.value === mode)?.label || mode} - ${new Date().toLocaleDateString()}`

    try {
      const res = await fetch('/api/ai/training/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          mode,
          messages,
          system_prompt_snapshot: systemPrompt,
        }),
      })

      if (!res.ok) throw new Error('Failed to save')
      toast.success('Conversation saved')
      fetchSavedConversations()
    } catch {
      toast.error('Failed to save conversation')
    }
  }

  function loadConversation(convo: AITestConversation) {
    setMessages(convo.messages)
    setMode(convo.mode)
    setSystemPrompt(convo.system_prompt_snapshot)
    setShowHistory(false)
  }

  async function deleteConversation(id: string) {
    await fetch(`/api/ai/training/conversations/${id}`, { method: 'DELETE' })
    setSavedConversations((prev) => prev.filter((c) => c.id !== id))
    toast.success('Conversation deleted')
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 h-[calc(100vh-280px)]">
      {/* Saved Conversations Sidebar - Desktop */}
      <div className="hidden lg:block space-y-2 overflow-y-auto">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-muted-foreground">Saved Conversations</h3>
        </div>
        {savedConversations.length === 0 ? (
          <p className="text-xs text-muted-foreground">No saved conversations yet</p>
        ) : (
          savedConversations.map((convo) => (
            <Card
              key={convo.id}
              className="cursor-pointer hover:bg-accent/50 transition-colors"
              onClick={() => loadConversation(convo)}
            >
              <CardContent className="py-2.5 px-3">
                <div className="flex items-start justify-between gap-1">
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate">{convo.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {convo.messages.length} msgs &middot; {new Date(convo.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 shrink-0"
                    onClick={(e) => {
                      e.stopPropagation()
                      deleteConversation(convo.id)
                    }}
                  >
                    <Trash2 className="h-3 w-3 text-muted-foreground" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* Main Chat Area */}
      <div className="lg:col-span-3 flex flex-col">
        {/* Top Bar */}
        <div className="flex items-center gap-3 mb-3 flex-wrap">
          <Select value={mode} onValueChange={(v) => v && setMode(v)}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Select mode">
                {MODES.find((m) => m.value === mode)?.label || mode}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {MODES.map((m) => (
                <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex-1" />

          {/* Mobile history toggle */}
          <Button
            variant="outline"
            size="sm"
            className="lg:hidden"
            onClick={() => setShowHistory(!showHistory)}
          >
            <History className="h-4 w-4 mr-1" />
            History
          </Button>

          <Button variant="outline" size="sm" onClick={handleNewConversation}>
            <RotateCcw className="h-4 w-4 mr-1" />
            New
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={handleSave}
            disabled={messages.length === 0}
          >
            <Save className="h-4 w-4 mr-1" />
            Save
          </Button>
        </div>

        {/* Mobile saved conversations dropdown */}
        {showHistory && (
          <Card className="mb-3 lg:hidden">
            <CardContent className="py-3 space-y-2">
              {savedConversations.length === 0 ? (
                <p className="text-xs text-muted-foreground">No saved conversations</p>
              ) : (
                savedConversations.slice(0, 10).map((convo) => (
                  <div
                    key={convo.id}
                    className="flex items-center justify-between py-1 cursor-pointer hover:text-primary"
                    onClick={() => loadConversation(convo)}
                  >
                    <span className="text-sm truncate">{convo.title}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteConversation(convo.id)
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        )}

        {/* Messages */}
        <Card className="flex-1 flex flex-col min-h-0">
          <CardContent className="flex-1 overflow-y-auto py-4">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <Sparkles className="h-12 w-12 text-muted-foreground/30 mb-3" />
                <h3 className="font-medium text-lg">AI Playground</h3>
                <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                  Test your AI assistant with different modes. The AI will use your training memories and knowledge base to respond.
                </p>
              </div>
            ) : (
              <>
                {messages.map((msg, i) => (
                  <ChatMessage
                    key={i}
                    role={msg.role as 'user' | 'assistant'}
                    content={msg.content}
                    timestamp={msg.timestamp}
                  />
                ))}
                {loading && (
                  <div className="flex gap-3 mb-4">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                      <Loader2 className="h-4 w-4 animate-spin" />
                    </div>
                    <div className="bg-muted rounded-lg px-4 py-2.5">
                      <p className="text-sm text-muted-foreground">Thinking...</p>
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
                placeholder="Type a message to test the AI..."
                rows={2}
                className="resize-none"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    sendMessage()
                  }
                }}
              />
              <Button onClick={sendMessage} disabled={loading || !input.trim()} className="self-end">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Press Cmd+Enter to send
            </p>
          </div>
        </Card>

        {/* System Prompt & Context Info */}
        {systemPrompt && (
          <Card className="mt-3">
            <CardHeader
              className="py-2.5 px-4 cursor-pointer"
              onClick={() => setShowSystemPrompt(!showSystemPrompt)}
            >
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  System Prompt Context
                  {memoriesUsed.length > 0 && (
                    <Badge variant="secondary" className="text-xs">
                      {memoriesUsed.length} memories
                    </Badge>
                  )}
                  {articlesUsed.length > 0 && (
                    <Badge variant="secondary" className="text-xs">
                      {articlesUsed.length} articles
                    </Badge>
                  )}
                </CardTitle>
                {showSystemPrompt ? (
                  <ChevronUp className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
            </CardHeader>
            {showSystemPrompt && (
              <CardContent className="pt-0 pb-3 px-4">
                {memoriesUsed.length > 0 && (
                  <div className="mb-3">
                    <p className="text-xs font-medium text-muted-foreground mb-1">Active Memories:</p>
                    <div className="flex flex-wrap gap-1">
                      {memoriesUsed.map((m) => (
                        <Badge key={m} variant="outline" className="text-xs">{m}</Badge>
                      ))}
                    </div>
                  </div>
                )}
                {articlesUsed.length > 0 && (
                  <div className="mb-3">
                    <p className="text-xs font-medium text-muted-foreground mb-1">Referenced Articles:</p>
                    <div className="flex flex-wrap gap-1">
                      {articlesUsed.map((a) => (
                        <Badge key={a.id} variant="outline" className="text-xs">{a.title}</Badge>
                      ))}
                    </div>
                  </div>
                )}
                <pre className="text-xs bg-muted rounded p-3 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap font-mono">
                  {systemPrompt}
                </pre>
              </CardContent>
            )}
          </Card>
        )}
      </div>
    </div>
  )
}
