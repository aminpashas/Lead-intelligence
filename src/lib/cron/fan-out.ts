/**
 * Cron fan-out — trigger sibling cron routes from a single dispatcher.
 *
 * Why this exists: Vercel caps the number of scheduled cron jobs per project (40
 * on Pro). We were over the cap, so a scattered subset of jobs — including
 * voice-reconcile — was silently never scheduled. To stay under the cap without
 * losing any job, crons that share a schedule are collapsed into one `batch-*`
 * route in vercel.json; that route fans back out to each real cron over HTTP.
 *
 * Each sub-cron keeps its own route, maxDuration, auth guard, and `cron_runs`
 * heartbeat — an HTTP POST here is indistinguishable from Vercel Cron invoking it
 * directly, so per-cron observability and failure isolation are preserved. Calls
 * run in parallel: each fetch spins up its own function instance, so the slowest
 * single sub-cron (not their sum) bounds the dispatcher's wall time.
 */

import type { NextRequest } from 'next/server'

export type FanOutResult = { cron: string; ok: boolean; status: number; error?: string }

/**
 * POST every target cron route (`/api/cron/<name>`) with the CRON_SECRET the
 * targets expect. Never rejects for a single failed target — the failure is
 * captured in that target's FanOutResult so one bad cron can't sink the batch.
 */
export async function fanOutToCrons(
  request: NextRequest,
  targets: readonly string[],
): Promise<FanOutResult[]> {
  const secret = process.env.CRON_SECRET
  if (!secret) throw new Error('CRON_SECRET not set — cannot dispatch sub-crons')

  // The alias Vercel Cron actually hit is the most correct base for internal
  // calls; fall back to the project's production URL if headers are absent.
  const proto = request.headers.get('x-forwarded-proto') || 'https'
  const host =
    request.headers.get('x-forwarded-host') ||
    request.headers.get('host') ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL
  if (!host) throw new Error('Cannot resolve host for cron dispatch')
  const base = `${proto}://${host}`

  return Promise.all(
    targets.map(async (cron): Promise<FanOutResult> => {
      try {
        const res = await fetch(`${base}/api/cron/${cron}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${secret}` },
        })
        return { cron, ok: res.ok, status: res.status }
      } catch (err) {
        return { cron, ok: false, status: 0, error: err instanceof Error ? err.message : 'fetch failed' }
      }
    }),
  )
}

/** Shape a fan-out into a CronOutcome-compatible summary for the dispatcher. */
export function summarizeFanOut(results: FanOutResult[]) {
  const failed = results.filter((r) => !r.ok)
  return {
    status: (failed.length ? 'failed' : 'ok') as 'failed' | 'ok',
    items: results.length - failed.length,
    error: failed.length
      ? `sub-crons failed: ${failed.map((f) => `${f.cron}(${f.status}${f.error ? ` ${f.error}` : ''})`).join(', ')}`
      : undefined,
    data: { results },
  }
}
