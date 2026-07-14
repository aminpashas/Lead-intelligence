import { Skeleton } from '@/components/ui/skeleton'

/**
 * Route-level Suspense fallback for /closing. Mirrors the page — header
 * block, the 4-up forecast stat-card row, then the closing-book table —
 * so the board streams in without layout shift.
 */
export default function ClosingLoading() {
  return (
    <div className="h-full">
      <header className="mb-6 border-b border-aurea-border pb-6">
        <Skeleton className="mb-2 h-3 w-24" />
        <Skeleton className="h-9 w-52 sm:h-11" />
        <Skeleton className="mt-2 h-4 w-96 max-w-full" />
      </header>

      {/* Forecast stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-aurea-border bg-aurea-surface px-4 py-3">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-2 h-7 w-20" />
          </div>
        ))}
      </div>

      {/* Closing-book table */}
      <div className="mt-4 overflow-hidden rounded-lg border border-aurea-border bg-aurea-surface">
        <div className="flex items-center gap-4 border-b border-aurea-border px-4 py-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-3 w-20" />
          ))}
        </div>
        {Array.from({ length: 8 }).map((_, row) => (
          <div key={row} className="flex items-center gap-4 border-b border-aurea-border px-4 py-3.5 last:border-b-0">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="ml-auto h-4 w-14" />
          </div>
        ))}
      </div>
    </div>
  )
}
