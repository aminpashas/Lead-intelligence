'use client'

import { useCallback, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Columns3, Rows3 } from 'lucide-react'

/**
 * Board ⇄ List switch for the Pipeline.
 *
 * View state lives in the URL (?view=list) like every other pipeline filter, so
 * the choice survives a refresh, is linkable, and — critically — lets the server
 * pick its query: the kanban fetches a capped card slice PER stage, while the
 * list runs one paginated whole-book query. They are different reads of the same
 * funnel, not two renderings of one payload.
 */
const VIEWS = [
  { key: 'board', label: 'Board', Icon: Columns3 },
  { key: 'list', label: 'List', Icon: Rows3 },
] as const

export function PipelineViewToggle({ current }: { current: 'board' | 'list' }) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const select = useCallback(
    (key: string) => {
      if (key === current) return
      const params = new URLSearchParams(searchParams.toString())
      // `view=board` is set explicitly (not deleted) so the mobile default
      // below can tell "user chose board" apart from "no choice yet".
      params.set('view', key)
      // Board has no pages; carrying a stale ?page into it (and back out) just
      // lands you mid-list on return.
      params.delete('page')
      const qs = params.toString()
      router.push(qs ? `/pipeline?${qs}` : '/pipeline')
    },
    [current, router, searchParams]
  )

  // Phones default to the List view — a 7-column kanban behind horizontal
  // scroll isn't a usable funnel on 375px. Only when the URL carries no
  // explicit choice, and only at mount (never in render — SSR markup must
  // match; same pattern as conversations-sidebar.tsx).
  useEffect(() => {
    if (searchParams.get('view')) return
    if (window.matchMedia('(min-width: 1024px)').matches) return
    const params = new URLSearchParams(searchParams.toString())
    params.set('view', 'list')
    params.delete('page')
    router.replace(`/pipeline?${params.toString()}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-time viewport check only
  }, [])

  return (
    <div
      role="group"
      aria-label="Pipeline view"
      className="inline-flex items-center gap-0.5 rounded-full border border-aurea-border bg-white p-0.5"
    >
      {VIEWS.map(({ key, label, Icon }) => {
        const active = key === current
        return (
          <button
            key={key}
            type="button"
            onClick={() => select(key)}
            aria-pressed={active}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] transition-colors ${
              active
                ? 'bg-aurea-ink text-white'
                : 'text-aurea-ink-3 hover:text-aurea-ink'
            }`}
          >
            <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
            {label}
          </button>
        )
      })}
    </div>
  )
}
