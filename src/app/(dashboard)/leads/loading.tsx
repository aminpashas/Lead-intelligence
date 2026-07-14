import { Skeleton } from '@/components/ui/skeleton'

/**
 * Route-level Suspense fallback for /leads. Mirrors the page — header with
 * eyebrow/title/count and action buttons, then a filter bar and table rows —
 * so the real table streams in without layout shift.
 */
export default function LeadsLoading() {
  return (
    <div>
      <header className="mb-8 flex flex-col gap-5 border-b border-aurea-border pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Skeleton className="mb-3 h-3 w-32" />
          <Skeleton className="h-10 w-40 sm:h-[52px]" />
          <Skeleton className="mt-2 h-4 w-24" />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Skeleton className="h-9 w-28 rounded-md" />
          <Skeleton className="h-9 w-28 rounded-md" />
        </div>
      </header>

      {/* Filter / search bar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Skeleton className="h-9 w-64 rounded-md" />
        <Skeleton className="h-9 w-32 rounded-md" />
        <Skeleton className="h-9 w-32 rounded-md" />
        <Skeleton className="h-9 w-32 rounded-md" />
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-aurea-border bg-aurea-surface">
        <div className="flex items-center gap-4 border-b border-aurea-border px-4 py-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-3 w-24" />
          ))}
        </div>
        {Array.from({ length: 10 }).map((_, row) => (
          <div key={row} className="flex items-center gap-4 border-b border-aurea-border px-4 py-3.5 last:border-b-0">
            <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="ml-auto h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  )
}
