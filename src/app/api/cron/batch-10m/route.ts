/**
 * Batch dispatcher — every-10-minutes cron group.
 *
 * Collapses five every-10-minute crons into one vercel.json entry (Vercel caps scheduled
 * jobs per project; see fan-out.ts). Each target still runs as its own function
 * with its own heartbeat — this route only triggers them, in parallel.
 */

import { withCron } from '@/lib/cron/with-cron'
import { fanOutToCrons, summarizeFanOut } from '@/lib/cron/fan-out'

export const runtime = 'nodejs'
// Bounded by the slowest single target (backfill-conversation-analysis, 300s),
// which runs in its own function instance — this is a max, not a sum.
export const maxDuration = 300

const TARGETS = [
  'reconcile-growth-studio-outbox',
  'forward-desk-outbox',
  'backfill-conversation-analysis',
  'dion-surgery-sync',
  'dion-inbox-reprocess',
] as const

export const POST = withCron('batch-10m', async ({ request }) => {
  const results = await fanOutToCrons(request, TARGETS)
  return summarizeFanOut(results)
})
