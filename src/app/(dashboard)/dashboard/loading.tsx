import { Skeleton } from '@/components/ui/skeleton'

/**
 * Route-level Suspense fallback for /dashboard. Mirrors DashboardHome —
 * greeting header, the 7-up mini-KPI row, then the two-band content grid —
 * so the dashboard streams in without layout shift.
 */
export default function DashboardLoading() {
  return (
    <div className="space-y-4">
      <header className="border-b border-aurea-border pb-8">
        <Skeleton className="mb-3 h-3 w-36" />
        <Skeleton className="h-10 w-80 max-w-full sm:h-12" />
        <Skeleton className="mt-4 h-4 w-full max-w-2xl" />
      </header>

      {/* Mini-KPI row */}
      <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-aurea-border bg-aurea-surface p-4">
            <Skeleton className="h-4 w-4 rounded" />
            <Skeleton className="mt-3 h-6 w-14" />
            <Skeleton className="mt-2 h-3 w-20" />
          </div>
        ))}
      </div>

      {/* Content cards */}
      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
        {[2, 1].map((span, i) => (
          <div
            key={i}
            className={`overflow-hidden rounded-lg border border-aurea-border bg-aurea-surface ${span === 2 ? 'lg:col-span-2' : ''}`}
          >
            <div className="border-b border-aurea-border px-5 py-4">
              <Skeleton className="h-4 w-40" />
            </div>
            <div className="space-y-4 p-5">
              {Array.from({ length: 5 }).map((_, row) => (
                <div key={row} className="flex items-center gap-3">
                  <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-2/5" />
                    <Skeleton className="h-3 w-3/5" />
                  </div>
                  <Skeleton className="h-4 w-12" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
