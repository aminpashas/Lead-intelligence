/**
 * Task sweep cron.
 *
 * Materializes state-shaped work (follow-ups, deadlines, patients awaiting a
 * reply) into `human_tasks` so /tasks shows the day's real work, and closes
 * swept tasks whose condition has cleared. See lib/automation/task-sweep.ts for
 * the rulebook and why `untouched_new` / escalations are excluded.
 *
 * Schedule: every 15 minutes, via the batch-15m dispatcher (Vercel caps
 * scheduled jobs per project, so new crons join a batch rather than vercel.json).
 */

import { withCron } from '@/lib/cron/with-cron'
import { sweepOrg } from '@/lib/automation/task-sweep'

export const runtime = 'nodejs'
export const maxDuration = 300

export const POST = withCron('task-sweep', async ({ supabase }) => {
  const { data: orgs, error } = await supabase.from('organizations').select('id, name')
  if (error) {
    return { status: 'failed', items: 0, error: `org read failed: ${error.message}` }
  }
  if (!orgs || orgs.length === 0) {
    return { status: 'skipped', items: 0, data: { reason: 'no_orgs' } }
  }

  let minted = 0
  let closed = 0
  let skipped = 0

  for (const org of orgs as { id: string; name: string | null }[]) {
    const r = await sweepOrg(supabase, org.id)
    minted += r.minted
    closed += r.closed
    skipped += r.skipped
  }

  return {
    status: 'ok',
    // Items = rows changed. A quiet run (0/0) is a real signal, not a failure:
    // it means every condition already has a task and none have cleared.
    items: minted + closed,
    data: { minted, closed, suppressed: skipped, orgs: orgs.length },
  }
})

// Vercel Cron invokes cron routes with GET; alias it (matches every other cron).
export const GET = POST
