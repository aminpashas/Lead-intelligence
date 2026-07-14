import Link from 'next/link'

// The one deal flow is split across three views of the same funnel. This row
// cross-links them from each page header so staff can move between them.
const FUNNEL_VIEWS = [
  { href: '/pipeline', label: 'Pipeline' },
  { href: '/closing', label: 'In Closing' },
  { href: '/post-close', label: 'Post-Close' },
] as const

export function FunnelViewNav({ current }: { current: string }) {
  return (
    <nav aria-label="Deal flow views" className="mt-4 flex flex-wrap items-center gap-1.5">
      {FUNNEL_VIEWS.map((v) => {
        const active = v.href === current
        return (
          <Link
            key={v.href}
            href={v.href}
            aria-current={active ? 'page' : undefined}
            className={
              active
                ? 'aurea-chip border border-aurea-primary/40 bg-aurea-primary/5 px-3 py-1 text-[12px] font-medium text-aurea-primary'
                : 'aurea-chip border border-aurea-border px-3 py-1 text-[12px] text-aurea-ink-3 transition-colors hover:border-aurea-ink-3/40 hover:text-aurea-ink'
            }
          >
            {v.label}
          </Link>
        )
      })}
    </nav>
  )
}
