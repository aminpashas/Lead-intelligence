/**
 * Batch dispatcher — every-15-minutes cron group.
 *
 * Collapses six every-15-minute crons into one vercel.json entry (Vercel caps scheduled
 * jobs per project; see fan-out.ts). Each target still runs as its own function
 * with its own heartbeat — this route only triggers them, in parallel.
 */

import { withCron } from '@/lib/cron/with-cron'
import { fanOutToCrons, summarizeFanOut } from '@/lib/cron/fan-out'

export const runtime = 'nodejs'
// Long enough to await the slowest single target; targets run in their own
// function instances, so this is a max, not a sum.
export const maxDuration = 300

const TARGETS = ['enrich', 'campaigns', 'reminders', 'follow-up-sequences', 'voice-reconcile', 'score-sweep'] as const

export const POST = withCron('batch-15m', async ({ request }) => {
  const results = await fanOutToCrons(request, TARGETS)
  return summarizeFanOut(results)
})

// Vercel Cron invokes cron routes with a GET request; alias it to the POST
// handler so this scheduled route actually runs (matches every other cron route).
export const GET = POST
