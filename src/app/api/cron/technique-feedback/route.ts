import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'

// POST /api/cron/technique-feedback — Nightly (03:30 UTC)
//
// Backfills message_technique_tracking.actual_effectiveness by
// looking at lead outcomes within 7 days of each tracked message.
// This closes the feedback loop: predicted_effectiveness gets a
// real-world signal that future auto-tune passes can train against.
//
// Scoring rubric (within 7 days of the technique message):
//   appointment booked  → 'effective'
//   inbound reply       → 'effective' (engaged the lead)
//   lead disqualified   → 'backfired'
//   no_show after book  → 'neutral' (booking happened, show didn't)
//   silence             → 'too_early' if <48h, else 'neutral'
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  const supabase = createServiceClient()

  // Look at messages tracked 2-14 days ago (gives outcomes time to
  // happen, but not so old that we re-score forever)
  const lookbackStart = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
  const lookbackEnd = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()

  const { data: pending, error } = await supabase
    .from('message_technique_tracking')
    .select('id, lead_id, conversation_id, created_at, technique_id, agent_type')
    .is('actual_effectiveness', null)
    .gte('created_at', lookbackStart)
    .lt('created_at', lookbackEnd)
    .limit(500) // chunk so a single run can't blow out

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!pending || pending.length === 0) {
    return NextResponse.json({ scored: 0, durationMs: Date.now() - startTime })
  }

  let scoredEffective = 0
  let scoredNeutral = 0
  let scoredBackfired = 0
  let scoredTooEarly = 0
  const errors: string[] = []

  for (const row of pending) {
    try {
      const trackedAt = new Date(row.created_at)
      const windowEnd = new Date(trackedAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
      const trackedAtIso = trackedAt.toISOString()

      // Did an appointment get booked for this lead within 7 days after?
      const { data: aptRows } = await supabase
        .from('appointments')
        .select('id, status, created_at')
        .eq('lead_id', row.lead_id)
        .gte('created_at', trackedAtIso)
        .lte('created_at', windowEnd)
        .limit(1)

      // Did the lead reply within 7 days?
      const { data: replyRows } = await supabase
        .from('messages')
        .select('id, created_at')
        .eq('lead_id', row.lead_id)
        .eq('direction', 'inbound')
        .gte('created_at', trackedAtIso)
        .lte('created_at', windowEnd)
        .limit(1)

      // Was the lead disqualified within 7 days?
      const { data: disqualRows } = await supabase
        .from('lead_activities')
        .select('id, activity_type, created_at')
        .eq('lead_id', row.lead_id)
        .eq('activity_type', 'disqualified')
        .gte('created_at', trackedAtIso)
        .lte('created_at', windowEnd)
        .limit(1)

      let outcome: 'effective' | 'neutral' | 'backfired' | 'too_early'
      if (aptRows && aptRows.length > 0) {
        outcome = 'effective'
      } else if (disqualRows && disqualRows.length > 0) {
        outcome = 'backfired'
      } else if (replyRows && replyRows.length > 0) {
        outcome = 'effective'
      } else {
        // Silence — distinguish too_early from neutral by elapsed time
        const elapsedHours = (Date.now() - trackedAt.getTime()) / (1000 * 60 * 60)
        outcome = elapsedHours < 48 ? 'too_early' : 'neutral'
      }

      const { error: updErr } = await supabase
        .from('message_technique_tracking')
        .update({ actual_effectiveness: outcome })
        .eq('id', row.id)

      if (updErr) {
        errors.push(`Update ${row.id}: ${updErr.message}`)
        continue
      }

      switch (outcome) {
        case 'effective':
          scoredEffective++
          break
        case 'neutral':
          scoredNeutral++
          break
        case 'backfired':
          scoredBackfired++
          break
        case 'too_early':
          scoredTooEarly++
          break
      }
    } catch (err) {
      errors.push(`Row ${row.id}: ${err instanceof Error ? err.message : 'unknown'}`)
    }
  }

  const summary = {
    success: true,
    candidates: pending.length,
    scored: scoredEffective + scoredNeutral + scoredBackfired + scoredTooEarly,
    breakdown: {
      effective: scoredEffective,
      neutral: scoredNeutral,
      backfired: scoredBackfired,
      too_early: scoredTooEarly,
    },
    errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
    durationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  }

  logger.info('Technique feedback cron completed', summary)
  return NextResponse.json(summary)
}

export async function GET(request: NextRequest) {
  return POST(request)
}
