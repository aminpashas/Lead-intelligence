/**
 * Human-response SLA takeover sweep (Workstream D3).
 *
 * POST /api/cron/sla-takeover — every minute (vercel.json): finds pending
 * `message_response_slas` rows whose deadline has passed and runs
 * `attemptTakeover` on each. Per row this either confirms a human already
 * replied ('human_responded'), lets the AI take over the thread
 * ('ai_takeover' — all autopilot gates still run), or records the breach
 * ('expired' + an sla_breach_review human task).
 *
 * Bounded at 50 rows per tick, oldest deadline first; a busy backlog drains
 * across consecutive minutes. Per-row failures never abort the sweep.
 */

import { withCron } from '@/lib/cron/with-cron'
import { attemptTakeover, type MessageResponseSla } from '@/lib/automation/sla'
import { logger } from '@/lib/logger'

const BATCH_SIZE = 50

export const POST = withCron('sla-takeover', async ({ supabase }) => {
  const { data: rows, error } = await supabase
    .from('message_response_slas')
    .select('*')
    .eq('status', 'pending')
    .lte('deadline_at', new Date().toISOString())
    .order('deadline_at', { ascending: true })
    .limit(BATCH_SIZE)

  if (error) {
    return { status: 'failed', items: 0, data: { error: error.message } }
  }

  const pending = (rows ?? []) as MessageResponseSla[]
  if (pending.length === 0) {
    return { items: 0, data: { processed: 0, takenOver: 0, humanRaced: 0, expired: 0 } }
  }

  let takenOver = 0
  let humanRaced = 0
  let expired = 0

  for (const row of pending) {
    try {
      const outcome = await attemptTakeover(supabase, row)
      if (outcome === 'taken_over') takenOver++
      else if (outcome === 'human_responded') humanRaced++
      else expired++
    } catch (err) {
      // attemptTakeover fails soft internally; this is belt-and-braces so one
      // bad row can never abort the sweep. The row stays pending and is
      // retried next tick.
      expired++
      logger.warn('SLA takeover sweep: row failed', {
        sla_id: row.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    items: pending.length,
    data: { processed: pending.length, takenOver, humanRaced, expired },
  }
})

export const GET = POST
