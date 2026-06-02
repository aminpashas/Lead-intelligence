/**
 * Next.js instrumentation — runs once when the server starts.
 * Used for environment validation, startup checks, and error monitoring.
 *
 * Exports:
 *   - register(): Called once on server init
 *   - onRequestError(): Called on every unhandled server error (API routes,
 *     Server Components, Server Actions) — sends to Sentry if configured
 */

import { type Instrumentation } from 'next'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { logEnvValidation } = await import('@/lib/env')
    logEnvValidation()

    // Initialize Sentry on server start (if configured)
    if (process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN) {
      const Sentry = await import('@sentry/nextjs')
      Sentry.init({
        dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
        environment: process.env.NODE_ENV || 'development',
        tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
        // Reduce noise: only capture errors, not breadcrumbs or spans
        beforeSend(event) {
          // Scrub PII from error reports (HIPAA compliance)
          if (event.request?.headers) {
            delete event.request.headers['authorization']
            delete event.request.headers['cookie']
          }
          return event
        },
      })
    }
  }
}

/**
 * Server-side error reporting via Next.js 16's onRequestError hook.
 * This catches unhandled errors from API routes, Server Components,
 * and Server Actions — and sends them to Sentry (or falls back to
 * console logging if Sentry isn't configured).
 */
export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context
) => {
  // Cast to typed error — Next.js passes `unknown` but it's always Error with digest
  const err = error as Error & { digest?: string }

  // Skip expected errors (user-facing, not bugs)
  if (err.digest?.startsWith('NEXT_NOT_FOUND') || err.digest?.startsWith('NEXT_REDIRECT')) {
    return
  }

  const errorData = {
    message: err.message,
    digest: err.digest,
    path: request.path,
    method: request.method,
    routePath: context.routePath,
    routeType: context.routeType,
    routerKind: context.routerKind,
    renderSource: context.renderSource,
    timestamp: new Date().toISOString(),
  }

  // If Sentry is configured, report there
  if (process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN) {
    try {
      const Sentry = await import('@sentry/nextjs')
      Sentry.captureException(err, {
        extra: errorData,
        tags: {
          route_type: context.routeType,
          router_kind: context.routerKind,
          route_path: context.routePath,
        },
      })
    } catch {
      // Sentry itself failed — fall back to console
      console.error('[onRequestError] Sentry capture failed, logging to console:', errorData)
    }
  } else {
    // No Sentry — log structured error for Vercel's log drain / stdout
    console.error(
      `[ERROR] ${context.routeType}:${request.method} ${request.path}`,
      JSON.stringify(errorData)
    )
  }
}


