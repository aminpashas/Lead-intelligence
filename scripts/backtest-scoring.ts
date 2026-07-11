/**
 * Backtest the lead-scoring models against realized outcomes.
 *
 * WHY: ai_score and the pipeline close-probability badge both claim to predict
 * conversion, but neither has ever been scored against what actually happened.
 * This script builds an outcome cohort from historical leads and reports how
 * well each model separates converters from non-converters (AUC) and how well
 * the predicted probabilities match reality (calibration).
 *
 * COHORT:
 *   positives — converted_at IS NOT NULL (stamped by the CareStack rollup)
 *   negatives — status in (lost, disqualified), OR unconverted leads that went
 *               quiet: created > 90d ago AND no contact in the last 90d
 *               (never-contacted old leads count as quiet).
 *   excluded  — everything else (still-open recent leads whose outcome is
 *               genuinely unknown; scoring them either way would bias the AUC).
 *
 * METRICS:
 *   - AUC (Mann-Whitney rank statistic, tie-corrected) of ai_score
 *   - AUC of scoreCloseProbability() — the REAL production function, imported
 *     from src/lib/pipeline/close-probability; base rate computed the same way
 *     the pipeline page does (computeCloseBaseRate over the leads' statuses)
 *   - Calibration: 10 deciles of predicted close probability vs actual rate
 *   - Per-dimension AUC from ai_score_breakdown.dimensions
 *
 * READ-ONLY: never writes. Paginates lead fetches (1000/page, keyset by id) to
 * avoid PostgREST row-cap truncation.
 *
 * Usage:
 *   npx tsx scripts/backtest-scoring.ts                  # all orgs
 *   LI_ORG_ID=<uuid> npx tsx scripts/backtest-scoring.ts # one org
 *
 * Env (from .env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Optional: LI_ORG_ID (filter to one org), STALE_DAYS (default 90)
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
config() // fallback to .env if present

import { createClient } from '@supabase/supabase-js'
import {
  computeCloseBaseRate,
  scoreCloseProbability,
  type CloseProbabilityInput,
} from '../src/lib/pipeline/close-probability'

function reqEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`❌ Missing required env: ${name}`)
    process.exit(1)
  }
  return v
}

const ORG_ID = process.env.LI_ORG_ID || null
const STALE_DAYS = Math.max(1, parseInt(process.env.STALE_DAYS || '90') || 90)
const PAGE = 1000
const NEGATIVE_STATUSES = new Set(['lost', 'disqualified'])

const supabase = createClient(
  reqEnv('NEXT_PUBLIC_SUPABASE_URL'),
  reqEnv('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { persistSession: false } }
)

type LeadRow = {
  id: string
  organization_id: string
  status: string
  created_at: string
  last_contacted_at: string | null
  converted_at: string | null
  ai_score: number | null
  ai_qualification: string | null
  ai_score_breakdown: unknown
  total_messages_sent: number | null
  total_messages_received: number | null
  financing_interest: string | null
  treatment_value: number | null
  no_show_count: number | null
}

type CohortLead = LeadRow & { positive: boolean }

// ── AUC (Mann-Whitney with average ranks for ties) ───────────────────────────

/**
 * AUC = P(score(random positive) > score(random negative)), computed as the
 * normalized Mann-Whitney U from average ranks (tie-corrected). Returns null
 * when either class is empty.
 */
function rankAuc(positives: number[], negatives: number[]): number | null {
  const nPos = positives.length
  const nNeg = negatives.length
  if (nPos === 0 || nNeg === 0) return null

  const all: Array<{ v: number; pos: boolean }> = []
  for (const v of positives) all.push({ v, pos: true })
  for (const v of negatives) all.push({ v, pos: false })
  all.sort((a, b) => a.v - b.v)

  let posRankSum = 0
  let i = 0
  while (i < all.length) {
    let j = i
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++
    const avgRank = (i + j + 2) / 2 // 1-based average rank across the tie group
    for (let k = i; k <= j; k++) if (all[k].pos) posRankSum += avgRank
    i = j + 1
  }
  return (posRankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg)
}

function fmtAuc(auc: number | null): string {
  return auc === null ? 'n/a' : auc.toFixed(3)
}

// ── Data fetch (keyset pagination, 1000/page) ────────────────────────────────

async function fetchAllLeads(): Promise<LeadRow[]> {
  const rows: LeadRow[] = []
  let lastId = '00000000-0000-0000-0000-000000000000'
  for (;;) {
    let q = supabase
      .from('leads')
      .select(
        'id, organization_id, status, created_at, last_contacted_at, converted_at, ' +
          'ai_score, ai_qualification, ai_score_breakdown, total_messages_sent, ' +
          'total_messages_received, financing_interest, treatment_value, no_show_count'
      )
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(PAGE)
    if (ORG_ID) q = q.eq('organization_id', ORG_ID)
    const { data, error } = await q
    if (error) {
      console.error('❌ Fetch error:', error.message)
      process.exit(1)
    }
    if (!data?.length) break
    // Cast via unknown: the concatenated select string defeats supabase-js's
    // template-literal result parser.
    const page = data as unknown as LeadRow[]
    rows.push(...page)
    lastId = page[page.length - 1].id
    if (page.length < PAGE) break
  }
  return rows
}

// ── Cohort assignment ────────────────────────────────────────────────────────

function buildCohort(leads: LeadRow[], nowMs: number) {
  const staleCutoffMs = nowMs - STALE_DAYS * 24 * 60 * 60 * 1000
  const cohort: CohortLead[] = []
  let excluded = 0

  for (const l of leads) {
    if (l.converted_at) {
      cohort.push({ ...l, positive: true })
      continue
    }
    const isDead = NEGATIVE_STATUSES.has(l.status)
    const createdOld = new Date(l.created_at).getTime() < staleCutoffMs
    const contactQuiet =
      !l.last_contacted_at || new Date(l.last_contacted_at).getTime() < staleCutoffMs
    if (isDead || (createdOld && contactQuiet)) {
      cohort.push({ ...l, positive: false })
    } else {
      excluded++ // still-open recent lead — outcome unknown
    }
  }
  return { cohort, excluded }
}

// ── Model inputs ─────────────────────────────────────────────────────────────

function toCloseProbInput(l: LeadRow): CloseProbabilityInput {
  return {
    ai_qualification: (l.ai_qualification ?? 'unscored') as CloseProbabilityInput['ai_qualification'],
    ai_score: l.ai_score ?? 0,
    total_messages_sent: l.total_messages_sent ?? 0,
    total_messages_received: l.total_messages_received ?? 0,
    financing_interest: l.financing_interest as CloseProbabilityInput['financing_interest'],
    treatment_value: l.treatment_value,
    no_show_count: l.no_show_count ?? 0,
    created_at: l.created_at,
  }
}

/**
 * Pull { name → score } out of ai_score_breakdown. The canonical writer
 * (rescoreAndPersistLead) stores { dimensions: [{ name, score, weight }],
 * confidence }; older webhook writers stored a flat object of numeric keys —
 * accept both.
 */
function breakdownDimensions(breakdown: unknown): Array<{ name: string; score: number }> {
  if (!breakdown || typeof breakdown !== 'object') return []
  const b = breakdown as Record<string, unknown>
  if (Array.isArray(b.dimensions)) {
    return (b.dimensions as Array<Record<string, unknown>>)
      .filter((d) => typeof d?.name === 'string' && typeof d?.score === 'number')
      .map((d) => ({ name: d.name as string, score: d.score as number }))
  }
  return Object.entries(b)
    .filter(([, v]) => typeof v === 'number')
    .map(([name, score]) => ({ name, score: score as number }))
}

// ── Calibration ──────────────────────────────────────────────────────────────

type CalibrationRow = {
  decile: number
  n: number
  meanPredicted: number
  actualRate: number
}

function calibrationDeciles(
  scored: Array<{ predicted: number; positive: boolean }>
): CalibrationRow[] {
  if (scored.length === 0) return []
  const sorted = [...scored].sort((a, b) => a.predicted - b.predicted)
  const rows: CalibrationRow[] = []
  for (let d = 0; d < 10; d++) {
    const start = Math.floor((d * sorted.length) / 10)
    const end = Math.floor(((d + 1) * sorted.length) / 10)
    const bucket = sorted.slice(start, end)
    if (bucket.length === 0) continue
    const meanPredicted = bucket.reduce((s, x) => s + x.predicted, 0) / bucket.length
    const actualRate = bucket.filter((x) => x.positive).length / bucket.length
    rows.push({ decile: d + 1, n: bucket.length, meanPredicted, actualRate })
  }
  return rows
}

// ── Report ───────────────────────────────────────────────────────────────────

async function main() {
  const nowMs = Date.now()
  console.log('# Lead-scoring backtest')
  console.log('')
  console.log(`- Run at: ${new Date(nowMs).toISOString()}`)
  console.log(`- Org filter: ${ORG_ID ?? 'ALL orgs'}`)
  console.log(`- Stale window: ${STALE_DAYS} days`)
  console.log('')

  const leads = await fetchAllLeads()
  const { cohort, excluded } = buildCohort(leads, nowMs)
  const positives = cohort.filter((l) => l.positive)
  const negatives = cohort.filter((l) => !l.positive)

  console.log('## Cohort')
  console.log('')
  console.log('| Bucket | Count |')
  console.log('| --- | ---: |')
  console.log(`| Leads fetched | ${leads.length} |`)
  console.log(`| Positives (converted_at set) | ${positives.length} |`)
  console.log(`| Negatives (lost/disqualified or stale) | ${negatives.length} |`)
  console.log(`| Excluded (still-open recent) | ${excluded} |`)
  console.log('')
  if (positives.length < 100) {
    console.log(
      `> ⚠️  Only ${positives.length} positives — below the ~100 needed for stable AUC/calibration. Treat every number below as directional, not conclusive.`
    )
    console.log('')
  }
  if (positives.length === 0 || negatives.length === 0) {
    console.log('> ❌ One outcome class is empty — AUC and calibration are undefined. Stopping.')
    return
  }

  // Base rate exactly the way the pipeline page computes it: over the statuses
  // of the leads in view (here: every fetched lead).
  const baseRate = computeCloseBaseRate(leads.map((l) => l.status))

  const aiScoreAuc = rankAuc(
    positives.map((l) => l.ai_score ?? 0),
    negatives.map((l) => l.ai_score ?? 0)
  )
  const closeProbOf = (l: CohortLead) => scoreCloseProbability(toCloseProbInput(l), baseRate, nowMs)
  const closeProbAuc = rankAuc(positives.map(closeProbOf), negatives.map(closeProbOf))

  console.log('## Model AUC (Mann-Whitney, tie-corrected)')
  console.log('')
  console.log('| Model | AUC | Notes |')
  console.log('| --- | ---: | --- |')
  console.log(`| ai_score | ${fmtAuc(aiScoreAuc)} | 0-100 AI lead score |`)
  console.log(
    `| scoreCloseProbability | ${fmtAuc(closeProbAuc)} | base rate ${baseRate.toPrecision(3)} (computeCloseBaseRate over ${leads.length} statuses) |`
  )
  console.log('')
  console.log('> 0.5 = coin flip · 0.7+ = useful · 0.8+ = strong. AUC is rank-based, so it is unaffected by the multiplicative base rate.')
  console.log('')

  console.log('## Calibration — close probability, 10 deciles')
  console.log('')
  const calRows = calibrationDeciles(cohort.map((l) => ({ predicted: closeProbOf(l), positive: l.positive })))
  console.log('| Decile | n | Mean predicted | Actual conversion |')
  console.log('| ---: | ---: | ---: | ---: |')
  for (const r of calRows) {
    console.log(
      `| ${r.decile} | ${r.n} | ${(r.meanPredicted * 100).toFixed(1)}% | ${(r.actualRate * 100).toFixed(1)}% |`
    )
  }
  console.log('')
  console.log('> Well-calibrated ⇒ the two right columns track each other decile by decile.')
  console.log('')

  console.log('## Per-dimension AUC (from ai_score_breakdown)')
  console.log('')
  const byDimension = new Map<string, { pos: number[]; neg: number[] }>()
  for (const l of cohort) {
    for (const { name, score } of breakdownDimensions(l.ai_score_breakdown)) {
      let bucket = byDimension.get(name)
      if (!bucket) {
        bucket = { pos: [], neg: [] }
        byDimension.set(name, bucket)
      }
      ;(l.positive ? bucket.pos : bucket.neg).push(score)
    }
  }
  if (byDimension.size === 0) {
    console.log('_No leads in the cohort carry an ai_score_breakdown — nothing to report._')
  } else {
    console.log('| Dimension | AUC | Positives w/ dim | Negatives w/ dim |')
    console.log('| --- | ---: | ---: | ---: |')
    const rows = [...byDimension.entries()]
      .map(([name, { pos, neg }]) => ({ name, auc: rankAuc(pos, neg), nPos: pos.length, nNeg: neg.length }))
      .sort((a, b) => (b.auc ?? -1) - (a.auc ?? -1))
    for (const r of rows) {
      console.log(`| ${r.name} | ${fmtAuc(r.auc)} | ${r.nPos} | ${r.nNeg} |`)
    }
  }
  console.log('')
  console.log('_Read-only backtest — no rows were written._')
}

main().catch((err) => {
  console.error('❌ Backtest failed:', err)
  process.exit(1)
})
