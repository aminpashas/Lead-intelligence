'use client'

/**
 * Command Center — the AI agent chat that anchors the dashboard.
 *
 * Staff talk to the agent in natural language ("text every hot lead who hasn't
 * replied this week"). The agent answers from live CRM data and, for bulk
 * outreach, returns PROPOSALS that render as confirmation cards here. Nothing
 * sends until the user presses Send, which posts to the existing hardened
 * /api/sms/mass and /api/email/mass endpoints (consent filter, A2P gate, daily
 * caps all enforced server-side there).
 */

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Sparkles, SendHorizonal, MessageSquare, Mail, Users, CheckCircle2,
  XCircle, Loader2, ShieldCheck,
} from 'lucide-react'

type ProposedAction = {
  id: string
  channel: 'sms' | 'email'
  name: string
  message_template?: string
  subject_template?: string
  body_template?: string
  lead_ids: string[]
  total_matched: number
  sendable_count: number
  sample_recipients: string[]
}

type ProposalState = ProposedAction & {
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'dismissed'
  resultSummary?: string
  error?: string
}

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  proposals?: ProposalState[]
}

const SUGGESTIONS = [
  'Text all hot leads who haven’t replied in 3 days',
  'How is the pipeline looking this week?',
  'Follow up with everyone who no-showed their consult',
  'Email leads interested in All-on-4 about our open slots',
]

export function CommandCenter({
  userName,
  initialMessage,
}: {
  userName: string
  /** When set, sent as the first user message on mount (the dashboard ask bar hands off here). */
  initialMessage?: string
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const sentInitial = useRef(false)

  useEffect(() => {
    if (initialMessage && !sentInitial.current) {
      sentInitial.current = true
      send(initialMessage)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, loading])

  async function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed || loading) return
    const next: ChatMessage[] = [...messages, { role: 'user', content: trimmed }]
    setMessages(next)
    setInput('')
    setLoading(true)

    try {
      const res = await fetch('/api/ai/command-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // History is client-held; strip UI-only fields before sending.
          messages: next.map((m) => ({ role: m.role, content: m.content })).slice(-20),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `Request failed (${res.status})`)
      }
      const data: { reply: string; proposals: ProposedAction[] } = await res.json()
      setMessages((cur) => [
        ...cur,
        {
          role: 'assistant',
          content: data.reply,
          proposals: (data.proposals || []).map((p) => ({ ...p, status: 'pending' as const })),
        },
      ])
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Something went wrong'
      toast.error(msg)
      setMessages((cur) => [
        ...cur,
        { role: 'assistant', content: `Sorry — I hit an error (${msg}). Try again.` },
      ])
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }

  function updateProposal(id: string, patch: Partial<ProposalState>) {
    setMessages((cur) =>
      cur.map((m) =>
        m.proposals?.some((p) => p.id === id)
          ? { ...m, proposals: m.proposals.map((p) => (p.id === id ? { ...p, ...patch } : p)) }
          : m
      )
    )
  }

  async function executeProposal(p: ProposalState) {
    updateProposal(p.id, { status: 'sending' })
    try {
      const endpoint = p.channel === 'sms' ? '/api/sms/mass' : '/api/email/mass'
      const body =
        p.channel === 'sms'
          ? { lead_ids: p.lead_ids, message_template: p.message_template, broadcast_name: p.name }
          : {
              lead_ids: p.lead_ids,
              subject_template: p.subject_template,
              body_template: p.body_template,
              broadcast_name: p.name,
            }
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Proposal id doubles as the idempotency key: double-clicks and
          // network retries can never re-send the same broadcast.
          'Idempotency-Key': p.id,
        },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        updateProposal(p.id, { status: 'failed', error: data.error || `Failed (${res.status})` })
        toast.error(data.error || 'Send failed')
        return
      }
      const capNote = data.dropped_for_daily_cap
        ? ` (${data.dropped_for_daily_cap} deferred by the daily cap)`
        : ''
      const summary = `Sent ${data.sent}/${data.total}${data.skipped ? `, ${data.skipped} skipped for consent` : ''}${data.failed ? `, ${data.failed} failed` : ''}${capNote}`
      updateProposal(p.id, { status: 'sent', resultSummary: summary })
      toast.success(summary)
    } catch {
      updateProposal(p.id, { status: 'failed', error: 'Network error — check Broadcasts before retrying' })
      toast.error('Network error — check Broadcasts before retrying')
    }
  }

  return (
    <section className="aurea-card flex flex-col overflow-hidden lg:h-[640px]">
      {/* Header */}
      <div className="flex items-center gap-2.5 border-b border-aurea-border px-5 py-4">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-aurea-primary/10 ring-1 ring-aurea-primary/20">
          <Sparkles className="h-3.5 w-3.5 text-aurea-primary" strokeWidth={1.75} />
        </span>
        <div>
          <h2 className="aurea-display text-[18px] leading-tight text-aurea-ink">AI Command Center</h2>
          <p className="text-[12px] text-aurea-ink-3">
            Ask about your pipeline or tell me what to run — sends always wait for your confirmation
          </p>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="min-h-[320px] flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-4 py-8 text-center">
            <p className="max-w-sm text-[14px] leading-relaxed text-aurea-ink-2">
              Hi {userName} — I can answer questions about your leads and run outreach for you.
              Try one of these:
            </p>
            <div className="flex max-w-md flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-full border border-aurea-border px-3 py-1.5 text-[12.5px] text-aurea-ink-2 transition-colors hover:bg-aurea-surface-2 hover:text-aurea-ink"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div className={`max-w-[85%] space-y-3 ${m.role === 'user' ? 'text-right' : ''}`}>
              <div
                className={
                  m.role === 'user'
                    ? 'inline-block rounded-2xl rounded-br-sm bg-aurea-ink px-4 py-2.5 text-left text-[14px] leading-relaxed text-aurea-surface'
                    : 'inline-block rounded-2xl rounded-bl-sm border border-aurea-border bg-aurea-surface-2 px-4 py-2.5 text-[14px] leading-relaxed text-aurea-ink'
                }
              >
                <p className="whitespace-pre-wrap">{m.content}</p>
              </div>
              {m.proposals?.map((p) => (
                <ProposalCard key={p.id} proposal={p} onSend={executeProposal} onDismiss={(id) => updateProposal(id, { status: 'dismissed' })} />
              ))}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex items-center gap-2 text-[13px] text-aurea-ink-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            Working on it…
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-aurea-border px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send(input)
              }
            }}
            rows={1}
            placeholder="Ask anything or give me a task…"
            className="max-h-32 min-h-[42px] flex-1 resize-none rounded-xl border border-aurea-border bg-aurea-surface px-3.5 py-2.5 text-[14px] text-aurea-ink placeholder:text-aurea-ink-3 focus:outline-none focus:ring-1 focus:ring-aurea-primary/40"
            disabled={loading}
          />
          <Button
            onClick={() => send(input)}
            disabled={loading || !input.trim()}
            size="icon"
            className="h-[42px] w-[42px] shrink-0 rounded-xl"
          >
            <SendHorizonal className="h-4 w-4" strokeWidth={1.75} />
          </Button>
        </div>
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-aurea-ink-3">
          <ShieldCheck className="h-3 w-3" strokeWidth={1.75} />
          Consent-filtered &middot; daily caps enforced &middot; bulk sends require your confirmation
        </p>
      </div>
    </section>
  )
}

/* ── Proposal card ──────────────────────────────────────── */

function ProposalCard({
  proposal: p,
  onSend,
  onDismiss,
}: {
  proposal: ProposalState
  onSend: (p: ProposalState) => void
  onDismiss: (id: string) => void
}) {
  const ChannelIcon = p.channel === 'sms' ? MessageSquare : Mail
  const unreachable = p.total_matched - p.sendable_count

  return (
    <div className="rounded-xl border border-aurea-border bg-aurea-surface p-4 text-left">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ChannelIcon className="h-3.5 w-3.5 text-aurea-primary" strokeWidth={1.75} />
          <p className="text-[13px] font-semibold text-aurea-ink">{p.name}</p>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-wide text-aurea-ink-3">
          Mass {p.channel}
        </span>
      </div>

      <div className="mb-2 flex items-center gap-2 text-[12px] text-aurea-ink-2">
        <Users className="h-3.5 w-3.5 text-aurea-ink-3" strokeWidth={1.75} />
        <span>
          <span className="font-semibold tabular-nums text-aurea-ink">{p.sendable_count}</span> reachable
          {unreachable > 0 && (
            <span className="text-aurea-ink-3"> &middot; {unreachable} excluded (no consent/contact)</span>
          )}
        </span>
      </div>

      {p.sample_recipients.length > 0 && (
        <p className="mb-2 truncate text-[11.5px] text-aurea-ink-3">
          Incl. {p.sample_recipients.join(', ')}
          {p.sendable_count > p.sample_recipients.length ? '…' : ''}
        </p>
      )}

      {p.channel === 'email' && p.subject_template && (
        <p className="mb-1 text-[12.5px] font-medium text-aurea-ink">Subject: {p.subject_template}</p>
      )}
      <div className="rounded-lg bg-aurea-surface-2 px-3 py-2 text-[13px] leading-relaxed text-aurea-ink-2">
        <p className="whitespace-pre-wrap">{p.channel === 'sms' ? p.message_template : p.body_template}</p>
      </div>

      <div className="mt-3">
        {p.status === 'pending' && (
          <div className="flex items-center gap-2">
            <Button size="sm" className="gap-1.5" onClick={() => onSend(p)}>
              <SendHorizonal className="h-3.5 w-3.5" strokeWidth={1.75} />
              Send to {p.sendable_count} {p.sendable_count === 1 ? 'lead' : 'leads'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onDismiss(p.id)}>
              Dismiss
            </Button>
          </div>
        )}
        {p.status === 'sending' && (
          <p className="flex items-center gap-1.5 text-[12.5px] text-aurea-ink-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} /> Sending…
          </p>
        )}
        {p.status === 'sent' && (
          <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-aurea-primary">
            <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} /> {p.resultSummary}
          </p>
        )}
        {p.status === 'failed' && (
          <div className="flex items-center gap-2">
            <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-aurea-rose">
              <XCircle className="h-3.5 w-3.5" strokeWidth={1.75} /> {p.error}
            </p>
            <Button size="sm" variant="outline" onClick={() => onSend(p)}>
              Retry
            </Button>
          </div>
        )}
        {p.status === 'dismissed' && (
          <p className="text-[12.5px] text-aurea-ink-3">Dismissed — not sent.</p>
        )}
      </div>
    </div>
  )
}
