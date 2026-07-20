/**
 * Batch dispatcher — every-15-minutes cron group.
 *
 * Collapses the every-15-minute crons into one vercel.json entry (Vercel caps scheduled
 * jobs per project; see fan-out.ts). Each target still runs as its own function
 * with its own heartbeat — this route only triggers them, in parallel.
 */

import { withCron } from '@/lib/cron/with-cron'
import { fanOutToCrons, summarizeFanOut } from '@/lib/cron/fan-out'

export const runtime = 'nodejs'
// Long enough to await the slowest single target; targets run in their own
// function instances, so this is a max, not a sum.
export const maxDuration = 300

// `score-sweep` is deliberately NOT in this list. It declares maxDuration 800,
// but a child's budget is meaningless when a 300s parent awaits it — the
// effective ceiling is this function's. Once the Anthropic credit outage lifted,
// score-sweep went from failing in ~0.7s to genuinely processing 200 leads at
// ~2-3s each (400-600s), so batch-15m was killed mid-await every tick: neither
// function ever reached its withCron finally-block, so BOTH silently stopped
// writing cron_runs rows while ~200 leads/hour were still being scored. It now
// has its own top-level entry in vercel.json and gets its full 800s.
const TARGETS = ['enrich', 'campaigns', 'reminders', 'follow-up-sequences', 'voice-reconcile', 'engagement-sweep', 'task-sweep'] as const

export const POST = withCron('batch-15m', async ({ request }) => {
  const results = await fanOutToCrons(request, TARGETS)
  return summarizeFanOut(results)
})

// Vercel Cron invokes cron routes with a GET request; alias it to the POST
// handler so this scheduled route actually runs (matches every other cron route).
export const GET = POST
