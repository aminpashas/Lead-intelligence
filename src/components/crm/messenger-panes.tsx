'use client'

import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

/**
 * Two-pane messenger shell that collapses to a single pane on phones.
 *
 * Desktop keeps the classic inbox-rail + thread layout. Below `lg` there is no
 * room for both — the rail alone (320px) is wider than the 343px of usable
 * width on a 375px screen, and the old layout put it next to a 380px panel
 * inside an `overflow-hidden` box, which clipped the thread to ~23px.
 *
 * So below `lg` we show exactly one pane, and the route already tells us which:
 * `/conversations` is the list, `/conversations/<id>` is a thread. Driving it
 * off the pathname rather than client state means no extra state to keep in
 * sync, no media-query hydration flash, and the browser/OS Back gesture works
 * because drilling into a thread is a real navigation.
 */
export function MessengerPanes({
  rail,
  children,
}: {
  rail: React.ReactNode
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const threadOpen = /^\/conversations\/[^/]+\/?$/.test(pathname)

  return (
    <div className="flex h-full overflow-hidden rounded-xl border border-aurea-border bg-aurea-surface">
      <div
        className={cn(
          'min-w-0 flex-1 lg:flex-none',
          threadOpen && 'hidden lg:block'
        )}
      >
        {rail}
      </div>
      <div
        className={cn(
          'min-w-0 flex-1 flex-col',
          threadOpen ? 'flex' : 'hidden lg:flex'
        )}
      >
        {children}
      </div>
    </div>
  )
}
