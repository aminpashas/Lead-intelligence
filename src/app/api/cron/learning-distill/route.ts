import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { runDistillation } from '@/lib/ai/learning/distill'

// POST /api/cron/learning-distill — Weekly (Mondays 04:30 UTC)
//
// The closing step of the outcome learning loop:
//   1. Contrast won vs lost episode cohorts + real technique outcomes (code).
//   2. Have Claude write one candidate rule per significant, prompt-fixable
//      finding.
//   3. Insert candidates as is_enabled=false / review_status='pending' —
//      humans approve on /agency/ai-learning before anything goes live.
//   4. Flag live auto-learned rules whose after-cohort underperforms.
// Every run is logged to learning_runs.
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  const supabase = createServiceClient()

  try {
    const result = await runDistillation(supabase)

    await supabase.from('learning_runs').insert({
      kind: 'distill',
      episode_count: result.episodeCount,
      technique_rows: result.techniqueRows,
      findings: result.findings,
      candidates_created: result.candidatesCreated,
      rules_flagged: result.rulesFlagged,
      duration_ms: Date.now() - startTime,
    })

    const summary = {
      success: true,
      episodes: result.episodeCount,
      techniqueRows: result.techniqueRows,
      findings: result.findings.length,
      candidatesCreated: result.candidatesCreated,
      rulesFlagged: result.rulesFlagged,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    }
    logger.info('Learning distillation cron completed', summary)
    return NextResponse.json(summary)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown'
    await supabase
      .from('learning_runs')
      .insert({ kind: 'distill', error: message, duration_ms: Date.now() - startTime })
    logger.error('Learning distillation cron failed', { error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  return POST(request)
}
