/**
 * DEPRECATED — forwards to /api/cron/ehr-daily-sync.
 *
 * This cron was renamed when it stopped being CareStack-specific and started
 * looping every configured EHR adapter. Kept as a thin shim for one release so
 * the Vercel cron entry can be switched over without a gap: whichever path
 * fires, the same work runs and heartbeats as 'ehr-daily-sync'.
 *
 * Delete once vercel.json has pointed at the new path through a full deploy.
 *
 * Note: `dynamic` and `maxDuration` are declared here rather than re-exported —
 * Next.js parses route segment config statically and rejects a re-export.
 */
import { POST as ehrDailySync } from '../ehr-daily-sync/route'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const POST = ehrDailySync
export const GET = ehrDailySync
