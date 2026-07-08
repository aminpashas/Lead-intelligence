'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Search,
  MessageSquare,
  Mail,
  Phone,
  Globe,
  SlidersHorizontal,
  X,
  Bot,
  Check,
} from 'lucide-react'

// ── Shape ────────────────────────────────────────────────────
// A PII-safe, render-ready projection of a conversation row. The server layout
// decrypts the lead once and hands down only what the list needs — the client
// never touches ciphertext and filtering stays instant (in-memory).
export type ConversationListItem = {
  id: string
  channel: string
  unread: number
  lastAt: string | null
  preview: string | null
  aiEnabled: boolean
  aiMode: string | null
  sentiment: string | null
  status: string
  name: string
  initials: string
  phone: string | null
  email: string | null
  score: number | null
  qualification: string | null
}

type ChannelFilter = 'all' | 'sms' | 'email' | 'voice'
type SortKey = 'recent' | 'unread' | 'score'

const QUALIFICATIONS = ['hot', 'warm', 'cold', 'unqualified'] as const
const SENTIMENTS = ['positive', 'neutral', 'negative', 'frustrated'] as const

// ── Compact relative time ────────────────────────────────────
// Messenger rows want "3d" / "4h" / "now", not "about 3 days ago".
function shortAgo(iso: string | null): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (s < 45) return 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  const w = Math.floor(d / 7)
  if (w < 5) return `${w}w`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo`
  return `${Math.floor(d / 365)}y`
}

function ChannelIcon({ channel, className }: { channel: string; className?: string }) {
  const c = className ?? 'h-3 w-3'
  if (channel === 'email') return <Mail className={c} strokeWidth={1.75} />
  if (channel === 'voice') return <Phone className={c} strokeWidth={1.75} />
  if (channel === 'web_chat' || channel === 'whatsapp') return <Globe className={c} strokeWidth={1.75} />
  return <MessageSquare className={c} strokeWidth={1.75} />
}

const QUAL_DOT: Record<string, string> = {
  hot: 'bg-aurea-rose',
  warm: 'bg-aurea-amber',
  cold: 'bg-aurea-ink-3',
  unqualified: 'bg-aurea-border-strong',
}

export function ConversationsSidebar({
  conversations,
}: {
  conversations: ConversationListItem[]
}) {
  const pathname = usePathname()
  const activeId = pathname?.startsWith('/conversations/')
    ? pathname.split('/')[2]
    : null

  const [query, setQuery] = useState('')
  const [channel, setChannel] = useState<ChannelFilter>('all')
  const [quals, setQuals] = useState<Set<string>>(new Set())
  const [sentiments, setSentiments] = useState<Set<string>>(new Set())
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [aiOnly, setAiOnly] = useState(false)
  const [sort, setSort] = useState<SortKey>('recent')
  const [showFilters, setShowFilters] = useState(false)

  // Opening a thread marks it read server-side; mirror that here so the unread
  // badge clears immediately without waiting for a list refetch.
  const [readLocally, setReadLocally] = useState<Set<string>>(new Set())

  function toggleIn(set: Set<string>, value: string, setter: (s: Set<string>) => void) {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    setter(next)
  }

  const activeFilterCount =
    (channel !== 'all' ? 1 : 0) +
    quals.size +
    sentiments.size +
    (unreadOnly ? 1 : 0) +
    (aiOnly ? 1 : 0) +
    (sort !== 'recent' ? 1 : 0)

  function clearAll() {
    setChannel('all')
    setQuals(new Set())
    setSentiments(new Set())
    setUnreadOnly(false)
    setAiOnly(false)
    setSort('recent')
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = conversations.filter((c) => {
      const unread = readLocally.has(c.id) ? 0 : c.unread
      if (channel !== 'all' && c.channel !== channel) return false
      if (unreadOnly && unread <= 0) return false
      if (aiOnly && !c.aiEnabled) return false
      if (quals.size > 0 && !(c.qualification && quals.has(c.qualification))) return false
      if (sentiments.size > 0 && !(c.sentiment && sentiments.has(c.sentiment))) return false
      if (q) {
        const hay = `${c.name} ${c.preview ?? ''} ${c.phone ?? ''} ${c.email ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })

    const withUnread = (c: ConversationListItem) => (readLocally.has(c.id) ? 0 : c.unread)
    rows.sort((a, b) => {
      if (sort === 'unread') {
        const d = withUnread(b) - withUnread(a)
        if (d !== 0) return d
      } else if (sort === 'score') {
        const d = (b.score ?? -1) - (a.score ?? -1)
        if (d !== 0) return d
      }
      // Tie-break (and default) on recency.
      return new Date(b.lastAt ?? 0).getTime() - new Date(a.lastAt ?? 0).getTime()
    })
    return rows
  }, [conversations, query, channel, quals, sentiments, unreadOnly, aiOnly, sort, readLocally])

  const totalUnread = conversations.reduce(
    (n, c) => n + (readLocally.has(c.id) ? 0 : c.unread),
    0
  )

  return (
    <aside className="flex h-full w-[320px] shrink-0 flex-col border-r border-aurea-border bg-aurea-surface lg:w-[380px]">
      {/* ── Header ───────────────────────────────────────────── */}
      <div className="border-b border-aurea-border px-4 pb-3 pt-4">
        <div className="flex items-baseline justify-between">
          <div className="flex items-baseline gap-2">
            <p className="aurea-eyebrow">Inbox</p>
            <span className="text-[11px] tabular-nums text-aurea-ink-3">
              {filtered.length}
              {filtered.length !== conversations.length && (
                <span className="text-aurea-ink-3/60"> / {conversations.length}</span>
              )}
            </span>
          </div>
          {totalUnread > 0 && (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-aurea-primary">
              <span className="h-1.5 w-1.5 rounded-full bg-aurea-primary" />
              {totalUnread} unread
            </span>
          )}
        </div>

        {/* Search */}
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-aurea-border bg-aurea-canvas px-2.5 py-2 focus-within:border-aurea-ink-3">
          <Search className="h-3.5 w-3.5 shrink-0 text-aurea-ink-3" strokeWidth={1.75} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, phone, email…"
            className="w-full bg-transparent text-[13px] text-aurea-ink placeholder:text-aurea-ink-3 focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="shrink-0 text-aurea-ink-3 hover:text-aurea-ink"
            >
              <X className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          )}
        </div>

        {/* Channel segmented + Filters toggle */}
        <div className="mt-2.5 flex items-center gap-2">
          <div className="inline-flex flex-1 overflow-hidden rounded-lg border border-aurea-border">
            {([
              ['all', 'All'],
              ['sms', 'SMS'],
              ['email', 'Email'],
              ['voice', 'Voice'],
            ] as const).map(([value, label]) => {
              const active = channel === value
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setChannel(value)}
                  aria-pressed={active}
                  className={`flex-1 px-2 py-1.5 text-[11.5px] font-medium transition-colors ${
                    active
                      ? 'bg-aurea-ink text-aurea-canvas'
                      : 'text-aurea-ink-3 hover:bg-aurea-surface-2 hover:text-aurea-ink'
                  }`}
                >
                  {label}
                </button>
              )
            })}
          </div>
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            aria-pressed={showFilters}
            title="Filters"
            className={`relative flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border transition-colors ${
              showFilters || activeFilterCount > 0
                ? 'border-aurea-primary/40 bg-aurea-primary/10 text-aurea-primary'
                : 'border-aurea-border text-aurea-ink-3 hover:bg-aurea-surface-2 hover:text-aurea-ink'
            }`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={1.75} />
            {activeFilterCount > 0 && (
              <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-aurea-primary px-1 text-[9px] font-semibold text-white">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>

        {/* Expandable filter drawer */}
        {showFilters && (
          <div className="mt-3 space-y-3 rounded-lg border border-aurea-border bg-aurea-canvas p-3 animate-in fade-in-0 slide-in-from-top-1 duration-200">
            <FilterGroup label="Qualification">
              {QUALIFICATIONS.map((qval) => (
                <Chip
                  key={qval}
                  active={quals.has(qval)}
                  onClick={() => toggleIn(quals, qval, setQuals)}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${QUAL_DOT[qval]}`} />
                  {qval}
                </Chip>
              ))}
            </FilterGroup>

            <FilterGroup label="Sentiment">
              {SENTIMENTS.map((sval) => (
                <Chip
                  key={sval}
                  active={sentiments.has(sval)}
                  onClick={() => toggleIn(sentiments, sval, setSentiments)}
                >
                  {sval}
                </Chip>
              ))}
            </FilterGroup>

            <FilterGroup label="Show only">
              <Chip active={unreadOnly} onClick={() => setUnreadOnly((v) => !v)}>
                Unread
              </Chip>
              <Chip active={aiOnly} onClick={() => setAiOnly((v) => !v)}>
                <Bot className="h-3 w-3" strokeWidth={1.75} /> AI active
              </Chip>
            </FilterGroup>

            <div className="flex items-center justify-between gap-2 border-t border-aurea-border pt-2.5">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] uppercase tracking-[0.1em] text-aurea-ink-3">Sort</span>
                {([
                  ['recent', 'Recent'],
                  ['unread', 'Unread'],
                  ['score', 'Score'],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setSort(value)}
                    className={`rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors ${
                      sort === value
                        ? 'bg-aurea-ink text-aurea-canvas'
                        : 'text-aurea-ink-3 hover:text-aurea-ink'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {activeFilterCount > 0 && (
                <button
                  type="button"
                  onClick={clearAll}
                  className="text-[11px] font-medium text-aurea-ink-3 underline-offset-2 hover:text-aurea-ink hover:underline"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── List ─────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-16 text-center">
            <MessageSquare className="mb-3 h-6 w-6 text-aurea-ink-3" strokeWidth={1.5} />
            <p className="text-[13px] font-medium text-aurea-ink">
              {conversations.length === 0 ? 'No conversations yet' : 'No matches'}
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-aurea-ink-3">
              {conversations.length === 0
                ? 'Conversations appear here when leads reply to SMS or email.'
                : 'Try a different search or clear your filters.'}
            </p>
          </div>
        ) : (
          <ul className="py-1">
            {filtered.map((c) => {
              const unread = readLocally.has(c.id) ? 0 : c.unread
              const active = c.id === activeId
              return (
                <li key={c.id}>
                  <Link
                    href={`/conversations/${c.id}`}
                    onClick={() =>
                      setReadLocally((prev) => new Set(prev).add(c.id))
                    }
                    className={`group relative flex gap-3 px-4 py-3 transition-colors ${
                      active ? 'bg-aurea-surface-2' : 'hover:bg-aurea-surface-2/60'
                    }`}
                  >
                    {/* Active accent rail */}
                    <span
                      className={`absolute left-0 top-0 h-full w-[2.5px] bg-aurea-primary transition-opacity ${
                        active ? 'opacity-100' : 'opacity-0'
                      }`}
                    />

                    {/* Avatar */}
                    <div className="relative shrink-0">
                      <div
                        className={`flex h-10 w-10 items-center justify-center rounded-full border ${
                          unread > 0
                            ? 'border-aurea-primary/40 bg-aurea-primary/10'
                            : 'border-aurea-border bg-aurea-canvas'
                        }`}
                      >
                        <span className="aurea-display text-[14px] text-aurea-ink-2">
                          {c.initials}
                        </span>
                      </div>
                      <span className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-aurea-surface bg-aurea-surface-2 text-aurea-ink-3">
                        <ChannelIcon channel={c.channel} className="h-2.5 w-2.5" />
                      </span>
                    </div>

                    {/* Body */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span
                          className={`truncate text-[13.5px] ${
                            unread > 0
                              ? 'font-semibold text-aurea-ink'
                              : 'font-medium text-aurea-ink'
                          }`}
                        >
                          {c.name}
                        </span>
                        <span className="shrink-0 text-[11px] tabular-nums text-aurea-ink-3">
                          {shortAgo(c.lastAt)}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center justify-between gap-2">
                        <p
                          className={`truncate text-[12px] ${
                            unread > 0 ? 'text-aurea-ink-2' : 'text-aurea-ink-3'
                          }`}
                        >
                          {c.preview || 'No messages yet'}
                        </p>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {c.qualification && QUAL_DOT[c.qualification] && (
                            <span
                              title={c.qualification}
                              className={`h-1.5 w-1.5 rounded-full ${QUAL_DOT[c.qualification]}`}
                            />
                          )}
                          {c.aiEnabled && (
                            <Bot
                              className="h-3 w-3 text-aurea-primary"
                              strokeWidth={1.75}
                              aria-label="AI active"
                            />
                          )}
                          {unread > 0 && (
                            <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-aurea-primary px-1 text-[10px] font-semibold tabular-nums text-white">
                              {unread}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </aside>
  )
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[10px] uppercase tracking-[0.1em] text-aurea-ink-3">{label}</div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11.5px] font-medium capitalize transition-colors ${
        active
          ? 'border-aurea-ink bg-aurea-ink text-aurea-canvas'
          : 'border-aurea-border bg-aurea-surface text-aurea-ink-2 hover:border-aurea-ink-3'
      }`}
    >
      {active && <Check className="h-3 w-3" strokeWidth={2.25} />}
      {children}
    </button>
  )
}
