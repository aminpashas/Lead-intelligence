import { Skeleton } from '@/components/ui/skeleton'

/**
 * Route-level Suspense fallback for /leads/[id]. Mirrors LeadDetail — a
 * back-arrow header strip, a wide conversation/timeline pane, and the
 * 380px details rail — so the detail view streams in without layout shift.
 */
export default function LeadDetailLoading() {
  return (
    <div className="flex h-full min-h-0">
      {/* Center pane: header strip + conversation skeleton */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-aurea-border px-4 py-3">
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="h-8 w-8 rounded-full" />
          <Skeleton className="h-5 w-44" />
          <div className="ml-auto flex items-center gap-2">
            <Skeleton className="h-8 w-40 rounded-full" />
            <Skeleton className="h-8 w-24 rounded-md" />
          </div>
        </div>
        <div className="flex-1 overflow-hidden px-4 py-6">
          <div className="mx-auto max-w-[680px] space-y-4">
            <Skeleton className="h-16 w-3/5 rounded-xl" />
            <Skeleton className="ml-auto h-12 w-1/2 rounded-xl" />
            <Skeleton className="h-20 w-2/3 rounded-xl" />
            <Skeleton className="ml-auto h-14 w-3/5 rounded-xl" />
            <Skeleton className="h-12 w-1/2 rounded-xl" />
            <Skeleton className="ml-auto h-16 w-2/3 rounded-xl" />
          </div>
        </div>
      </div>

      {/* Details rail */}
      <aside className="hidden w-[380px] shrink-0 border-l border-aurea-border bg-aurea-canvas lg:block">
        <div className="space-y-5 p-5">
          <div className="space-y-2">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-48" />
          </div>
          <Skeleton className="h-9 w-full rounded-md" />
          <div className="grid grid-cols-2 gap-2">
            <Skeleton className="h-16 rounded-md" />
            <Skeleton className="h-16 rounded-md" />
            <Skeleton className="h-16 rounded-md" />
            <Skeleton className="h-16 rounded-md" />
          </div>
          <Skeleton className="h-32 w-full rounded-md" />
        </div>
      </aside>
    </div>
  )
}
