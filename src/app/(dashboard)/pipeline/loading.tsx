import { Skeleton } from '@/components/ui/skeleton'

/**
 * Route-level Suspense fallback for /pipeline. Mirrors the page's rendered
 * shape — header block, service-chip row, then a rail of kanban columns —
 * so the board streams in without layout shift.
 */
export default function PipelineLoading() {
  return (
    <div className="h-full">
      <header className="mb-6 border-b border-aurea-border pb-6">
        <Skeleton className="mb-2 h-3 w-24" />
        <Skeleton className="h-9 w-44 sm:h-11" />
        <Skeleton className="mt-2 h-4 w-72" />
      </header>

      {/* Service-line chip row */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-7 w-24 rounded-full" />
        ))}
      </div>

      {/* Kanban columns */}
      <div className="flex gap-3 overflow-x-hidden pb-4 h-[calc(100vh-16rem)]">
        {Array.from({ length: 5 }).map((_, col) => (
          <div
            key={col}
            className="flex w-72 shrink-0 flex-col rounded-lg border border-aurea-border bg-aurea-surface"
          >
            <div className="flex items-center gap-2 border-b border-aurea-border p-3">
              <Skeleton className="h-1.5 w-1.5 rounded-full" />
              <Skeleton className="h-3 w-28" />
              <Skeleton className="ml-auto h-3 w-8" />
            </div>
            <div className="flex-1 space-y-2 overflow-hidden p-2">
              {Array.from({ length: 4 }).map((_, card) => (
                <div key={card} className="rounded-lg border border-aurea-border bg-aurea-surface p-3">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="mt-2 h-3 w-24" />
                  <Skeleton className="mt-2 h-3 w-40" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
