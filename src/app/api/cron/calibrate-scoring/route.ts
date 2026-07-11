import { withCron } from '@/lib/cron/with-cron'
import {
  fitLogistic,
  predictProba,
  computeAuc,
  computeBrier,
  calibrationBins,
  trainTestSplit,
  type ModelCoefficients,
} from '@/lib/scoring/calibration'
import {
  buildFeatureVector,
  toFeatureArray,
  featureNames,
  labelLeadOutcome,
  FEATURE_SCHEMA_VERSION,
  STALE_NEGATIVE_DAYS,
  type FeatureInput,
  type OutcomeLabelInput,
} from '@/lib/scoring/features'

/**
 * POST /api/cron/calibrate-scoring — weekly empirical close-probability fit.
 *
 * Replaces the hand-tuned multiplicative heuristic with an L2 logistic
 * regression trained on real outcomes (converted vs lost/disqualified/stale —
 * see labelLeadOutcome, the single cohort rule shared with backtests):
 *
 *  1. Fit a pooled (all-org) model plus a per-org model for every org with
 *     ≥ MIN_CONVERTED converted leads; evaluate each on a seeded 80/20 holdout.
 *  2. Insert EVERY fit into scoring_model_versions for auditability; only
 *     activate it (deactivating the prior) when holdout AUC hasn't regressed
 *     more than AUC_REGRESSION_TOLERANCE vs the currently active model.
 *  3. Stamp active (non-terminal) leads' close_probability from each org's
 *     best model (org-scoped if active, else pooled) — capped per org so the
 *     weekly run stays bounded; unstamped leads keep the live heuristic.
 *
 * Scheduled weekly (vercel.json, Sundays 02:00 UTC). Heartbeats via withCron.
 */

const MODEL_KIND = 'close_probability_lr'
const PAGE_SIZE = 1000
/** Bound the training cohort per org (pages × PAGE_SIZE rows). */
const MAX_COHORT_PAGES_PER_ORG = 20
/** Minimum converted outcomes before a scope gets its own fit. */
const MIN_CONVERTED = 100
/** Reject activation when holdout AUC drops more than this vs the active model. */
const AUC_REGRESSION_TOLERANCE = 0.02
/** Stamping is capped per org per run to bound the weekly write load. */
const STAMP_CAP_PER_ORG = 5000

/** Statuses whose outcome is settled — no point stamping a live probability. */
const TERMINAL_STATUSES = [
  'contract_signed', 'scheduled', 'in_treatment', 'completed', 'lost', 'disqualified',
]

const LEAD_COLUMNS = [
  'id', 'organization_id', 'status', 'converted_at', 'last_contacted_at',
  'ai_score', 'ai_qualification', 'total_messages_sent', 'total_messages_received',
  'financing_interest', 'treatment_value', 'no_show_count', 'created_at',
  'conversation_intent', 'enrichment_score', 'gclid', 'fbclid', 'utm_medium',
].join(', ')

type CohortLead = FeatureInput & OutcomeLabelInput & { id: string; organization_id: string }

type SupabaseClient = Parameters<Parameters<typeof withCron>[1]>[0]['supabase']

/**
 * Fetch an org's labelable cohort, paginated. The SQL predicate over-selects
 * (old-but-recently-contacted leads come back unlabelable); labelLeadOutcome
 * is the ground truth and drops them.
 */
async function fetchCohort(
  supabase: SupabaseClient,
  orgId: string,
  nowMs: number
): Promise<CohortLead[]> {
  const staleCutoffIso = new Date(nowMs - STALE_NEGATIVE_DAYS * 86_400_000).toISOString()
  const outcomeOr = [
    'converted_at.not.is.null',
    `status.in.(${TERMINAL_STATUSES.join(',')})`,
    `created_at.lt.${staleCutoffIso}`,
  ].join(',')

  const rows: CohortLead[] = []
  for (let page = 0; page < MAX_COHORT_PAGES_PER_ORG; page++) {
    const { data, error } = await supabase
      .from('leads')
      .select(LEAD_COLUMNS)
      .eq('organization_id', orgId)
      .or(outcomeOr)
      .order('created_at', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    if (error) throw new Error(`cohort fetch failed for org ${orgId}: ${error.message}`)
    if (!data || data.length === 0) break
    rows.push(...(data as unknown as CohortLead[]))
    if (data.length < PAGE_SIZE) break
  }
  return rows
}

type ScopeFit = {
  scope: string
  modelId: string | null
  activated: boolean
  n_total: number
  n_converted: number
  auc: number | null
  brier: number | null
  skipped?: string
}

/** Fit one scope (org or pooled), insert the version row, apply the activation guard. */
async function fitAndStoreScope(
  supabase: SupabaseClient,
  orgId: string | null,
  cohort: CohortLead[],
  nowMs: number
): Promise<ScopeFit> {
  const scope = orgId ?? 'pooled'

  // Label + featurize through the shared single-source-of-truth helpers.
  const X: number[][] = []
  const y: number[] = []
  for (const lead of cohort) {
    const label = labelLeadOutcome(lead, nowMs)
    if (label === null) continue
    X.push(toFeatureArray(buildFeatureVector(lead, undefined, nowMs)))
    y.push(label)
  }

  const nConverted = y.reduce((s, v) => s + v, 0)
  const base = { scope, n_total: y.length, n_converted: nConverted }
  if (nConverted < MIN_CONVERTED) {
    return { ...base, modelId: null, activated: false, auc: null, brier: null, skipped: `converted < ${MIN_CONVERTED}` }
  }
  if (nConverted === y.length) {
    return { ...base, modelId: null, activated: false, auc: null, brier: null, skipped: 'no negative outcomes' }
  }

  const { trainX, trainY, testX, testY } = trainTestSplit(X, y, 0.2, 42)
  const fit = fitLogistic(trainX, trainY, { l2: 1.0 })
  const coefficients: ModelCoefficients = {
    intercept: fit.intercept,
    features: Object.fromEntries(featureNames.map((name, i) => [name, fit.weights[i]])),
  }

  const holdoutProbs = testX.map((row) =>
    predictProba(coefficients, Object.fromEntries(featureNames.map((name, i) => [name, row[i]])))
  )
  const auc = computeAuc(holdoutProbs, testY)
  const brier = computeBrier(holdoutProbs, testY)
  const bins = calibrationBins(holdoutProbs, testY, 10)

  // Activation guard: never let a materially worse fit displace a good one,
  // but always keep the audit row.
  let activeQuery = supabase
    .from('scoring_model_versions')
    .select('id, training_stats')
    .eq('model_kind', MODEL_KIND)
    .eq('is_active', true)
  activeQuery = orgId ? activeQuery.eq('organization_id', orgId) : activeQuery.is('organization_id', null)
  const { data: current } = await activeQuery.maybeSingle()

  const currentAuc =
    current && typeof (current.training_stats as { auc?: unknown })?.auc === 'number'
      ? ((current.training_stats as { auc: number }).auc)
      : null
  const activate = !current || currentAuc === null || auc >= currentAuc - AUC_REGRESSION_TOLERANCE

  // Deactivate BEFORE inserting the new active row — the partial unique index
  // allows only one active model per scope.
  if (activate && current) {
    const { error } = await supabase
      .from('scoring_model_versions')
      .update({ is_active: false })
      .eq('id', current.id)
    if (error) throw new Error(`deactivating prior model failed (${scope}): ${error.message}`)
  }

  const { data: inserted, error: insertError } = await supabase
    .from('scoring_model_versions')
    .insert({
      organization_id: orgId,
      model_kind: MODEL_KIND,
      coefficients,
      training_stats: { n_total: y.length, n_converted: nConverted, auc, brier, calibration_bins: bins },
      feature_schema_version: FEATURE_SCHEMA_VERSION,
      is_active: activate,
    })
    .select('id')
    .single()
  if (insertError) throw new Error(`model insert failed (${scope}): ${insertError.message}`)

  return { ...base, modelId: inserted.id as string, activated: activate, auc, brier }
}

/** The org's active model for stamping: org-scoped if active, else pooled. */
async function resolveStampingModel(
  supabase: SupabaseClient,
  orgId: string
): Promise<{ id: string; coefficients: ModelCoefficients } | null> {
  const { data: orgModel } = await supabase
    .from('scoring_model_versions')
    .select('id, coefficients')
    .eq('model_kind', MODEL_KIND)
    .eq('is_active', true)
    .eq('organization_id', orgId)
    .maybeSingle()
  if (orgModel) return orgModel as { id: string; coefficients: ModelCoefficients }

  const { data: pooled } = await supabase
    .from('scoring_model_versions')
    .select('id, coefficients')
    .eq('model_kind', MODEL_KIND)
    .eq('is_active', true)
    .is('organization_id', null)
    .maybeSingle()
  return (pooled as { id: string; coefficients: ModelCoefficients } | null) ?? null
}

/**
 * Stamp calibrated probabilities onto an org's non-terminal leads (freshest
 * first, capped). Rounded to 3 d.p. and grouped by value so a page of 1000
 * leads costs a handful of UPDATE ... WHERE id IN (...) calls, not 1000.
 */
async function stampOrgLeads(
  supabase: SupabaseClient,
  orgId: string,
  model: { id: string; coefficients: ModelCoefficients },
  nowMs: number
): Promise<number> {
  const stampedAtIso = new Date(nowMs).toISOString()
  let stamped = 0

  for (let page = 0; page * PAGE_SIZE < STAMP_CAP_PER_ORG; page++) {
    const { data, error } = await supabase
      .from('leads')
      .select(LEAD_COLUMNS)
      .eq('organization_id', orgId)
      .not('status', 'in', `(${TERMINAL_STATUSES.map((s) => `"${s}"`).join(',')})`)
      .order('created_at', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    if (error) throw new Error(`stamp fetch failed for org ${orgId}: ${error.message}`)
    if (!data || data.length === 0) break

    const idsByValue = new Map<string, string[]>()
    for (const lead of data as unknown as CohortLead[]) {
      const p = predictProba(model.coefficients, buildFeatureVector(lead, undefined, nowMs))
      const value = Math.max(0, Math.min(1, p)).toFixed(3)
      const ids = idsByValue.get(value)
      if (ids) ids.push(lead.id)
      else idsByValue.set(value, [lead.id])
    }

    for (const [value, ids] of idsByValue) {
      const { error: updateError } = await supabase
        .from('leads')
        .update({
          close_probability: Number(value),
          close_probability_model_id: model.id,
          close_probability_at: stampedAtIso,
        })
        .in('id', ids)
      if (updateError) throw new Error(`stamp update failed for org ${orgId}: ${updateError.message}`)
      stamped += ids.length
    }

    if (data.length < PAGE_SIZE) break
  }
  return stamped
}

export const POST = withCron('calibrate-scoring', async ({ supabase }) => {
  const nowMs = Date.now()

  const { data: orgs, error: orgsError } = await supabase.from('organizations').select('id')
  if (orgsError) throw new Error(`organizations fetch failed: ${orgsError.message}`)
  if (!orgs || orgs.length === 0) {
    return { status: 'skipped', items: 0, data: { message: 'No organizations' } }
  }

  const fits: ScopeFit[] = []
  const stampedByOrg: Record<string, number> = {}
  const errors: string[] = []

  // 1. Per-org cohorts (also pooled ingredients). A failing org degrades the
  //    run instead of killing it — the others still calibrate.
  const cohortByOrg = new Map<string, CohortLead[]>()
  for (const org of orgs) {
    try {
      cohortByOrg.set(org.id, await fetchCohort(supabase, org.id, nowMs))
    } catch (err) {
      errors.push(err instanceof Error ? err.message : `cohort fetch failed for org ${org.id}`)
    }
  }

  // 2. Pooled fit first (it is the fallback model), then per-org fits.
  try {
    const pooledCohort = Array.from(cohortByOrg.values()).flat()
    fits.push(await fitAndStoreScope(supabase, null, pooledCohort, nowMs))
  } catch (err) {
    errors.push(err instanceof Error ? err.message : 'pooled fit failed')
  }
  for (const [orgId, cohort] of cohortByOrg) {
    try {
      fits.push(await fitAndStoreScope(supabase, orgId, cohort, nowMs))
    } catch (err) {
      errors.push(err instanceof Error ? err.message : `fit failed for org ${orgId}`)
    }
  }

  // 3. Stamp non-terminal leads for every org that now has a usable model.
  for (const org of orgs) {
    try {
      const model = await resolveStampingModel(supabase, org.id)
      if (!model) continue
      stampedByOrg[org.id] = await stampOrgLeads(supabase, org.id, model, nowMs)
    } catch (err) {
      errors.push(err instanceof Error ? err.message : `stamping failed for org ${org.id}`)
    }
  }

  const totalStamped = Object.values(stampedByOrg).reduce((s, v) => s + v, 0)
  const fitted = fits.filter((f) => f.modelId !== null).length

  return {
    status: errors.length > 0 && fitted === 0 && totalStamped === 0 ? 'failed' : 'ok',
    items: fitted + totalStamped,
    data: { fits, stamped: stampedByOrg, total_stamped: totalStamped, errors },
  }
})

export const GET = POST
