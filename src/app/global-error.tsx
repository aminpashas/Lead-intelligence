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
        <div className="flex min-h-screen items-center justify-center bg-background p-4">
          <div className="mx-auto max-w-md text-center space-y-6">
            <div className="flex justify-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500/10">
                <AlertCircle className="h-8 w-8 text-red-500" />
              </div>
            </div>
            <div className="space-y-2">
              <h1 className="text-2xl font-bold tracking-tight">Something went wrong</h1>
              <p className="text-muted-foreground text-sm">
                An unexpected error occurred. Our team has been notified and is looking into it.
              </p>
              {error.digest && (
                <p className="text-xs text-muted-foreground/60 font-mono">
                  Error ID: {error.digest}
                </p>
              )}
            </div>
            <Button onClick={reset} className="gap-2">
              <RefreshCw className="h-4 w-4" />
              Try Again
            </Button>
          </div>
        </div>
      </body>
    </html>
  )
}
