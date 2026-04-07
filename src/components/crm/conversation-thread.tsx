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
} from 'lucide-react'
import { toast } from 'sonner'
import type { Conversation, Message, Lead } from '@/types/database'

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

      if (!res.ok) throw new Error('AI generation failed')

      const { message } = await res.json()
      setDraft(message)
      toast.success('AI draft generated — review and send')
    } catch {
      toast.error('Failed to generate AI message')
    } finally {
      setGenerating(false)
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
          </div>
        </div>
      </div>

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
        {/* AI Generate */}
        <div className="flex items-center gap-2">
          <Select value={aiMode} onValueChange={(v) => v && setAiMode(v)}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="education">Educate about All-on-4</SelectItem>
              <SelectItem value="objection_handling">Handle Objections</SelectItem>
              <SelectItem value="appointment_scheduling">Schedule Consultation</SelectItem>
              <SelectItem value="follow_up">Follow Up</SelectItem>
            </SelectContent>
          </Select>
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
            Generate AI Draft
          </Button>
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
