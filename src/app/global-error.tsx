'use client'

/**
 * Global error boundary for the app.
 * Catches unhandled client-side errors and reports to Sentry if configured.
 * Also provides a user-friendly error recovery UI.
 */

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { AlertCircle, RefreshCw } from 'lucide-react'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Report to Sentry on the client side
    if (typeof window !== 'undefined' && (process.env.NEXT_PUBLIC_SENTRY_DSN)) {
      import('@sentry/nextjs').then(Sentry => {
        Sentry.captureException(error, {
          tags: { boundary: 'global-error' },
          extra: { digest: error.digest },
        })
      }).catch(() => {
        // Sentry not available — just log
        console.error('[GlobalError]', error)
      })
    } else {
      console.error('[GlobalError]', error)
    }
  }, [error])

  return (
    <html lang="en">
      <body>
        <div className="aurea aurea-floor flex min-h-screen items-center justify-center p-4">
          <div className="mx-auto max-w-md space-y-6 text-center">
            <div className="flex justify-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-aurea-rose/10 ring-1 ring-aurea-rose/20">
                <AlertCircle className="h-8 w-8 text-aurea-rose" strokeWidth={1.75} />
              </div>
            </div>
            <div className="space-y-2">
              <p className="aurea-eyebrow">Error</p>
              <h1 className="aurea-display text-[30px] text-aurea-ink">Something went wrong</h1>
              <p className="text-[14px] text-aurea-ink-2">
                An unexpected error occurred. Our team has been notified and is looking into it.
              </p>
              {error.digest && (
                <p className="font-mono text-[11px] text-aurea-ink-3">
                  Error ID: {error.digest}
                </p>
              )}
            </div>
            <Button onClick={reset} className="gap-2">
              <RefreshCw className="h-4 w-4" strokeWidth={1.75} />
              Try Again
            </Button>
          </div>
        </div>
      </body>
    </html>
  )
}
