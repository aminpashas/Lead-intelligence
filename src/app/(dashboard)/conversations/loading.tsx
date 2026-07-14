import { Skeleton } from '@/components/ui/skeleton'

/**
 * Route-level Suspense fallback for the /conversations page slot. The inbox
 * rail is rendered by the persistent layout, so this only needs to fill the
 * center thread pane — a thread header strip plus message-bubble skeletons.
 */
export default function ConversationsLoading() {
  return (
    <div className="flex h-full flex-col">
      {/* Thread header strip */}
      <div className="flex items-center gap-3 border-b border-aurea-border px-4 py-3">
        <Skeleton className="h-9 w-9 rounded-full" />
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-3 w-24" />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Skeleton className="h-8 w-20 rounded-md" />
          <Skeleton className="h-8 w-8 rounded-md" />
        </div>
      </div>

      {/* Message bubbles */}
      <div className="flex-1 space-y-4 overflow-hidden px-6 py-6">
        <Skeleton className="h-14 w-3/5 rounded-xl" />
        <Skeleton className="ml-auto h-12 w-1/2 rounded-xl" />
        <Skeleton className="h-16 w-2/3 rounded-xl" />
        <Skeleton className="ml-auto h-10 w-2/5 rounded-xl" />
        <Skeleton className="h-12 w-1/2 rounded-xl" />
        <Skeleton className="ml-auto h-14 w-3/5 rounded-xl" />
      </div>

      {/* Composer */}
      <div className="border-t border-aurea-border p-4">
        <Skeleton className="h-11 w-full rounded-lg" />
      </div>
    </div>
  )
}
