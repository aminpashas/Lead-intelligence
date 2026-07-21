'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Search, Loader2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { leadDisplayName, leadInitials } from '@/lib/leads/display-name'
import { cn } from '@/lib/utils'

/** Minimal shape the typeahead needs from a decrypted lead row. */
type LeadResult = {
  id: string
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  phone?: string | null
  phone_formatted?: string | null
  ai_qualification?: string | null
}

// Match the qualification dots used across the CRM (see Conversations filters).
const QUAL_DOT: Record<string, string> = {
  hot: 'bg-red-500',
  warm: 'bg-amber-500',
  cold: 'bg-sky-500',
  unqualified: 'bg-aurea-ink-3',
}

const MIN_CHARS = 2
const DEBOUNCE_MS = 250

/**
 * Global lead search with a live typeahead.
 *
 * Live results come from `GET /api/leads/search`, which matches names (substring)
 * plus email/phone (exact, via deterministic hashes, since those columns are
 * encrypted at rest). That endpoint fires a HIPAA PHI-read audit per call, so we
 * debounce and require a minimum query length before hitting it. Pressing Enter
 * without picking a result falls through to the full `/leads?search=` page.
 */
export function LeadSearch({
  autoFocus = false,
  placeholder = 'Search leads by name, email, or phone...',
  onNavigate,
}: {
  autoFocus?: boolean
  placeholder?: string
  onNavigate?: () => void
}) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<LeadResult[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)

  // Debounced live lookup. AbortController cancels the in-flight request when the
  // query changes so a slow early keystroke can't overwrite fresher results.
  useEffect(() => {
    const q = query.trim()
    if (q.length < MIN_CHARS) {
      setResults([])
      setLoading(false)
      return
    }

    const controller = new AbortController()
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/leads/search?q=${encodeURIComponent(q)}&limit=8`,
          { signal: controller.signal },
        )
        if (!res.ok) throw new Error('search failed')
        const json = await res.json()
        setResults(json.leads || [])
        setActiveIndex(-1)
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setResults([])
        }
      } finally {
        setLoading(false)
      }
    }, DEBOUNCE_MS)

    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [query])

  // Close the dropdown on outside click.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function goToLead(lead: LeadResult) {
    setOpen(false)
    setQuery('')
    onNavigate?.()
    router.push(`/leads/${lead.id}`)
  }

  function runFullSearch() {
    const q = query.trim()
    if (!q) return
    setOpen(false)
    onNavigate?.()
    router.push(`/leads?search=${encodeURIComponent(q)}`)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActiveIndex((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, -1))
    } else if (e.key === 'Enter') {
      if (activeIndex >= 0 && results[activeIndex]) {
        goToLead(results[activeIndex])
      } else {
        runFullSearch()
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  const showDropdown = open && query.trim().length >= MIN_CHARS

  return (
    <div ref={containerRef} className="relative flex-1">
      <Search
        className="absolute left-3 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-aurea-ink-3"
        strokeWidth={1.75}
      />
      <Input
        autoFocus={autoFocus}
        role="combobox"
        aria-expanded={showDropdown}
        aria-autocomplete="list"
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        className="pl-9 bg-aurea-surface border-aurea-border text-aurea-ink placeholder:text-aurea-ink-3 focus-visible:ring-aurea-primary/30"
      />

      {showDropdown && (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1.5 overflow-hidden rounded-lg border border-aurea-border bg-aurea-surface shadow-lg"
        >
          {loading && results.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-3 text-[13px] text-aurea-ink-3">
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
              Searching…
            </div>
          ) : results.length === 0 ? (
            <div className="px-3 py-3 text-[13px] text-aurea-ink-3">
              No leads match “{query.trim()}”.
            </div>
          ) : (
            <ul className="max-h-80 overflow-y-auto py-1">
              {results.map((lead, i) => {
                const qual = lead.ai_qualification?.toLowerCase()
                const secondary = lead.email || lead.phone_formatted || lead.phone
                return (
                  <li key={lead.id} role="option" aria-selected={i === activeIndex}>
                    <button
                      type="button"
                      onMouseEnter={() => setActiveIndex(i)}
                      onClick={() => goToLead(lead)}
                      className={cn(
                        'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors',
                        i === activeIndex ? 'bg-aurea-surface-2' : 'hover:bg-aurea-surface-2',
                      )}
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-aurea-surface-2 text-[11px] font-semibold text-aurea-ink-2 ring-1 ring-aurea-border">
                        {leadInitials(lead) || <Search className="h-3.5 w-3.5 text-aurea-ink-3" strokeWidth={1.75} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-medium text-aurea-ink">
                          {leadDisplayName(lead)}
                        </span>
                        {secondary && (
                          <span className="block truncate font-mono text-[11px] text-aurea-ink-3">
                            {secondary}
                          </span>
                        )}
                      </span>
                      {qual && (
                        <span className="flex shrink-0 items-center gap-1.5 text-[11px] capitalize text-aurea-ink-3">
                          <span className={cn('h-2 w-2 rounded-full', QUAL_DOT[qual] || 'bg-aurea-ink-3')} />
                          {qual}
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
              {/* Escape hatch to the full, hash-backed search page. */}
              <li role="option" aria-selected={false}>
                <button
                  type="button"
                  onClick={runFullSearch}
                  className="flex w-full items-center gap-2 border-t border-aurea-border px-3 py-2 text-left text-[12px] text-aurea-ink-2 hover:bg-aurea-surface-2"
                >
                  <Search className="h-3.5 w-3.5" strokeWidth={1.75} />
                  See all results for “{query.trim()}”
                </button>
              </li>
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
