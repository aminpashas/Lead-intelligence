'use client'

/**
 * Segment error boundary for all dashboard pages. Because this lives inside the
 * (dashboard) layout, a page-level crash (e.g. a chart throwing on a null field)
 * degrades to a contained, recoverable card WITHIN the shell — sidebar/topbar
 * stay put — instead of bubbling to the global boundary and blanking the app.
 */

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { AlertCircle, RefreshCw } from 'lucide-react'

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Report to Sentry if configured; otherwise log for local debugging.
    if (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_SENTRY_DSN) {
      import('@sentry/nextjs')
        .then((Sentry) => {
          Sentry.captureException(error, {
            tags: { boundary: 'dashboard-segment' },
            extra: { digest: error.digest },
          })
        })
        .catch(() => console.error('[DashboardError]', error))
    } else {
      console.error('[DashboardError]', error)
    }
  }, [error])

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-4">
      <div className="mx-auto max-w-md space-y-6 text-center">
        <div className="flex justify-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-aurea-rose/10 ring-1 ring-aurea-rose/20">
            <AlertCircle className="h-7 w-7 text-aurea-rose" strokeWidth={1.75} />
          </div>
        </div>
        <div className="space-y-2">
          <p className="aurea-eyebrow">Error</p>
          <h1 className="aurea-display text-[26px] text-aurea-ink">This section couldn&rsquo;t load</h1>
          <p className="text-[14px] text-aurea-ink-2">
            Something went wrong rendering this page. The rest of the app is unaffected — try again, or
            head back to your dashboard.
          </p>
          {error.digest && (
            <p className="font-mono text-[11px] text-aurea-ink-3">Error ID: {error.digest}</p>
          )}
        </div>
        <div className="flex items-center justify-center gap-2">
          <Button onClick={reset} className="gap-2">
            <RefreshCw className="h-4 w-4" strokeWidth={1.75} />
            Try Again
          </Button>
          <Button variant="outline" onClick={() => { window.location.href = '/dashboard' }}>
            Back to Dashboard
          </Button>
        </div>
      </div>
    </div>
  )
}
