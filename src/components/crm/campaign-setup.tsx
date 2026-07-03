'use client'

/**
 * Campaign Setup — service-line blueprint cards + the AI onboarding interview.
 *
 * Flow: pick a line → chat with the interviewer (answers land in the practice
 * profile via the server-side tool) → the required-answer checklist fills in
 * live → Launch creates the blueprint campaign as a DRAFT reviewed in the
 * normal campaign UI. Launch eligibility comes from the server (`gaps`),
 * never from anything computed here.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  ArrowLeft, CheckCircle2, Circle, Loader2, Rocket, SendHorizonal, Sparkles,
} from 'lucide-react'

type Gap = { path: string; question: string }

type LineStatus = {
  slug: string
  name: string
  description: string
  required: number
  answered: number
  gaps: Gap[]
  launched_campaign_id: string | null
  launched_campaign_status: string | null
}

type ProfileStatus = {
  self_serve_enabled: boolean
  last_interview_at: string | null
  lines: LineStatus[]
}

type ChatMessage = { role: 'user' | 'assistant'; content: string }

export function CampaignSetup({
  isAdmin,
  isAgencyAdmin,
}: {
  isAdmin: boolean
  isAgencyAdmin: boolean
}) {
  const [status, setStatus] = useState<ProfileStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [togglingSelfServe, setTogglingSelfServe] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/campaigns/onboarding/profile')
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `Request failed (${res.status})`)
      }
      setStatus(await res.json())
      setStatusError(null)
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Failed to load setup status')
    }
  }, [])

  useEffect(() => {
    refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, chatLoading])

  const line = status?.lines.find((l) => l.slug === selected) ?? null

  async function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed || chatLoading || !selected) return
    const next: ChatMessage[] = [...messages, { role: 'user', content: trimmed }]
    setMessages(next)
    setInput('')
    setChatLoading(true)
    try {
      const res = await fetch('/api/campaigns/onboarding/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_line: selected,
          messages: next.slice(-30),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `Request failed (${res.status})`)
      }
      const data: { reply: string; gaps: Gap[]; completeness: { answered: number; required: number } } =
        await res.json()
      setMessages((cur) => [...cur, { role: 'assistant', content: data.reply }])
      // Checklist state comes from the server response — keep the card in sync.
      setStatus((cur) =>
        cur
          ? {
              ...cur,
              lines: cur.lines.map((l) =>
                l.slug === selected
                  ? { ...l, gaps: data.gaps, answered: data.completeness.answered, required: data.completeness.required }
                  : l
              ),
            }
          : cur
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Something went wrong'
      toast.error(msg)
      setMessages((cur) => [
        ...cur,
        { role: 'assistant', content: `Sorry — I hit an error (${msg}). Try again.` },
      ])
    } finally {
      setChatLoading(false)
    }
  }

  async function launch() {
    if (!selected || launching) return
    setLaunching(true)
    try {
      const res = await fetch('/api/campaigns/onboarding/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service_line: selected }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 201) {
        toast.success('Draft campaign created — review and activate it in Campaigns.')
        await refreshStatus()
      } else if (res.status === 409 && data.campaign_id) {
        toast.info('This campaign already exists.')
        await refreshStatus()
      } else if (res.status === 422) {
        toast.error('A few required answers are still missing — the checklist shows which.')
        await refreshStatus()
      } else {
        throw new Error(data.error || `Launch failed (${res.status})`)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Launch failed')
    } finally {
      setLaunching(false)
    }
  }

  async function toggleSelfServe(enabled: boolean) {
    setTogglingSelfServe(true)
    try {
      const res = await fetch('/api/campaigns/onboarding/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ self_serve_enabled: enabled }),
      })
      if (!res.ok) throw new Error('Failed to update setting')
      setStatus((cur) => (cur ? { ...cur, self_serve_enabled: enabled } : cur))
      toast.success(enabled ? 'Practice self-serve enabled' : 'Practice self-serve disabled')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update setting')
    } finally {
      setTogglingSelfServe(false)
    }
  }

  if (statusError) {
    return (
      <div className="p-8">
        <p className="text-sm text-muted-foreground">{statusError}</p>
      </div>
    )
  }

  if (!status) {
    return (
      <div className="flex items-center justify-center p-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  }

  // ── Card grid (no line selected) ─────────────────────────────────
  if (!line) {
    return (
      <div className="space-y-6 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Campaign setup</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick a service line. The AI will interview you about how your practice runs —
              hours, consult flow, technology, pricing — and configure the campaign from your answers.
            </p>
          </div>
          {isAgencyAdmin && (
            <label className="flex shrink-0 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={status.self_serve_enabled}
                disabled={togglingSelfServe}
                onChange={(e) => toggleSelfServe(e.target.checked)}
              />
              Practice self-serve
            </label>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {status.lines.map((l) => {
            const complete = l.gaps.length === 0
            return (
              <button
                key={l.slug}
                onClick={() => {
                  setSelected(l.slug)
                  setMessages([])
                }}
                className="rounded-xl border bg-card p-5 text-left transition-colors hover:border-primary/50"
              >
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-medium">{l.name}</h2>
                  {l.launched_campaign_id ? (
                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-400">
                      {l.launched_campaign_status === 'active' ? 'Live' : 'Draft created'}
                    </span>
                  ) : complete ? (
                    <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-xs text-blue-700 dark:text-blue-400">
                      Ready to launch
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{l.description}</p>
                <div className="mt-4">
                  <div className="h-1.5 w-full rounded-full bg-muted">
                    <div
                      className="h-1.5 rounded-full bg-primary transition-all"
                      style={{ width: `${l.required ? Math.round((l.answered / l.required) * 100) : 0}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {l.answered}/{l.required} required answers
                  </p>
                </div>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  // ── Interview view (line selected) ───────────────────────────────
  const complete = line.gaps.length === 0
  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-4 p-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
            <ArrowLeft className="mr-1 h-4 w-4" /> All campaigns
          </Button>
          <h1 className="text-lg font-semibold">{line.name} setup</h1>
        </div>
        {isAdmin &&
          (line.launched_campaign_id ? (
            <Link
              href="/campaigns"
              className="inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
            >
              View campaign
            </Link>
          ) : (
            <Button size="sm" disabled={!complete || launching} onClick={launch}>
              {launching ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Rocket className="mr-1 h-4 w-4" />
              )}
              Launch draft campaign
            </Button>
          ))}
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1fr_320px]">
        {/* Chat pane */}
        <div className="flex min-h-0 flex-col rounded-xl border bg-card">
          <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {messages.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                <Sparkles className="h-6 w-6" />
                <p className="max-w-sm">
                  Tell me about your practice — or just say “hi” and I’ll walk you through the{' '}
                  {line.name.toLowerCase()} questions one at a time.
                </p>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                <div
                  className={
                    m.role === 'user'
                      ? 'max-w-[85%] whitespace-pre-wrap rounded-2xl bg-primary px-4 py-2 text-sm text-primary-foreground'
                      : 'max-w-[85%] whitespace-pre-wrap rounded-2xl bg-muted px-4 py-2 text-sm'
                  }
                >
                  {m.content}
                </div>
              </div>
            ))}
            {chatLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> thinking…
              </div>
            )}
          </div>
          <form
            className="flex items-end gap-2 border-t p-3"
            onSubmit={(e) => {
              e.preventDefault()
              send(input)
            }}
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send(input)
                }
              }}
              rows={1}
              placeholder="Answer here…"
              className="max-h-32 flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            />
            <Button type="submit" size="icon" disabled={chatLoading || !input.trim()}>
              <SendHorizonal className="h-4 w-4" />
            </Button>
          </form>
        </div>

        {/* Checklist pane */}
        <div className="hidden min-h-0 flex-col overflow-y-auto rounded-xl border bg-card p-4 lg:flex">
          <h2 className="text-sm font-medium">Launch checklist</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {line.answered}/{line.required} required answers
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            {complete ? (
              <li className="flex items-start gap-2 text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                Everything required is answered — ready to launch.
              </li>
            ) : (
              line.gaps.map((g) => (
                <li key={g.path} className="flex items-start gap-2 text-muted-foreground">
                  <Circle className="mt-0.5 h-4 w-4 shrink-0" />
                  {g.question}
                </li>
              ))
            )}
          </ul>
        </div>
      </div>
    </div>
  )
}
