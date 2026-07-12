import { withCron } from '@/lib/cron/with-cron'
import { gatherPipelineSignals } from '@/lib/pipeline/pipeline-signals'
import { buildRecommendations } from '@/lib/pipeline/recommendations'
import { syncRecommendations } from '@/lib/pipeline/recommendation-store'
import { runPipelineAnalyst } from '@/lib/pipeline/analyst'
import { isPostCloseStage, isOffFunnelStage } from '@/lib/pipeline/stage-groups'

/**
 * POST /api/cron/pipeline-recommendations — hourly at :40 (offset from the
 * :20 analyze-conversations sweep so the two LLM crons never stack).
 *
 * Per active org, two independent layers:
 *   1. DETERMINISTIC (always runs): gather whole-book signals → rules engine →
 *      syncRecommendations persists the output to pipeline_recommendations
 *      (refresh open rows, expire keys that stopped firing). This is what the
 *      Pipeline page reads, so it must succeed even when the LLM can't.
 *   2. ANALYST (best-effort): the Sonnet pipeline analyst reranks the open
 *      rows and may add ≤2 insight rows — aggregates in, gated output out
 *      (see src/lib/pipeline/analyst.ts). Failures degrade to layer 1.
 *
 * Signals are gathered UNFILTERED (serviceOr = null) — persisted rows describe
 * the whole book, matching what the page shows without a treatment chip.
 */

export const maxDuration = 300

export const POST = withCron('pipeline-recommendations', async ({ supabase }) => {
  const nowMs = Date.now()
  const startedAt = nowMs

  const { data: orgs, error: orgsError } = await supabase
    .from('organizations')
    .select('id')
    .eq('subscription_status', 'active')
  if (orgsError) throw new Error(`organizations fetch failed: ${orgsError.message}`)
  if (!orgs || orgs.length === 0) {
    return { status: 'skipped', items: 0, data: { message: 'No active organizations' } }
  }

  let totalSynced = 0
  const orgResults: Array<Record<string, unknown>> = []
  const errors: string[] = []

  for (const org of orgs) {
    // Leave headroom before the function timeout; the next hourly run catches up.
    if (Date.now() - startedAt > (maxDuration - 60) * 1000) break

    try {
      // Same stage universe as the Pipeline page: pre-close funnel only.
      const { data: stages, error: stagesError } = await supabase
        .from('pipeline_stages')
        .select('*')
        .eq('organization_id', org.id)
        .order('position', { ascending: true })
      if (stagesError) throw new Error(`stages fetch failed: ${stagesError.message}`)

      const allStages = (stages ?? []).filter(
        (s: { slug: string | null }) => !isPostCloseStage(s.slug) && !isOffFunnelStage(s.slug)
      )
      if (allStages.length === 0) {
        orgResults.push({ organization_id: org.id, skipped: 'no stages' })
        continue
      }

      const signals = await gatherPipelineSignals(supabase, org.id, allStages, null, nowMs)
      const recs = buildRecommendations(signals)
      const sync = await syncRecommendations(supabase, org.id, recs, nowMs)
      totalSynced += sync.inserted + sync.refreshed

      // Analyst pass — fails soft by contract (result carries its own error).
      const analyst = await runPipelineAnalyst(supabase, org.id, signals, nowMs)

      orgResults.push({
        organization_id: org.id,
        recommendations: recs.length,
        ...sync,
        analyst: {
          ran: analyst.ran,
          reranks_applied: analyst.reranksApplied,
          insights_accepted: analyst.insightsAccepted,
          insights_expired: analyst.insightsExpired,
          rejections: analyst.rejections.length,
          error: analyst.error ?? null,
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : `sync failed for org ${org.id}`
      errors.push(message)
      orgResults.push({ organization_id: org.id, error: message })
    }
  }

  return {
    status: errors.length > 0 && totalSynced === 0 ? 'failed' : 'ok',
    items: totalSynced,
    data: { organizations: orgResults, errors },
  }
})

export const GET = POST
