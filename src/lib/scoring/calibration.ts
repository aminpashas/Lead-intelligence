/**
 * Plain-TypeScript logistic-regression calibration — no numeric deps.
 *
 * Fits an L2-regularized logistic regression via IRLS (iteratively reweighted
 * least squares / Newton steps): deterministic, converges in a handful of
 * iterations on the bounded 0..1 feature vectors produced by
 * `src/lib/scoring/features.ts`, and the feature count (~13) keeps the Newton
 * solve trivial. Also provides the holdout metrics the calibrate-scoring cron
 * stores alongside each model version: rank-based AUC, Brier score, and
 * calibration bins.
 */

/** Stored model shape — matches scoring_model_versions.coefficients. */
export type ModelCoefficients = {
  intercept: number
  features: Record<string, number>
}

export type FitOptions = {
  /** L2 penalty on weights (intercept is not penalized). */
  l2?: number
  maxIter?: number
  /** Convergence threshold on the max absolute coefficient step. */
  tol?: number
}

export type FitResult = { intercept: number; weights: number[] }

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z))

/** Solve the linear system A·x = b (in place on copies) via Gaussian elimination. */
function solveLinearSystem(A: number[][], b: number[]): number[] {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])

  for (let col = 0; col < n; col++) {
    // Partial pivot for numeric stability.
    let pivot = col
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r
    }
    ;[M[col], M[pivot]] = [M[pivot], M[col]]

    const p = M[col][col]
    if (Math.abs(p) < 1e-12) continue // singular direction — leave step at 0

    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const factor = M[r][col] / p
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c]
    }
  }

  const x = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    x[i] = Math.abs(M[i][i]) < 1e-12 ? 0 : M[i][n] / M[i][i]
  }
  return x
}

/**
 * Fit L2-regularized logistic regression.
 *
 * @param X rows of feature values (same order for every row)
 * @param y labels 0/1, same length as X
 */
export function fitLogistic(X: number[][], y: number[], opts: FitOptions = {}): FitResult {
  const { l2 = 1.0, maxIter = 200, tol = 1e-6 } = opts
  const n = X.length
  if (n === 0 || n !== y.length) throw new Error('fitLogistic: X and y must be non-empty and aligned')
  const d = X[0].length

  // beta[0] = intercept, beta[1..d] = weights.
  const beta = new Array<number>(d + 1).fill(0)

  for (let iter = 0; iter < maxIter; iter++) {
    // Gradient of the penalized negative log-likelihood, and the Hessian.
    const grad = new Array<number>(d + 1).fill(0)
    const hess: number[][] = Array.from({ length: d + 1 }, () => new Array<number>(d + 1).fill(0))

    for (let i = 0; i < n; i++) {
      let z = beta[0]
      for (let j = 0; j < d; j++) z += beta[j + 1] * X[i][j]
      const p = sigmoid(z)
      const resid = y[i] - p
      const w = Math.max(p * (1 - p), 1e-9) // IRLS weight; floored for stability

      grad[0] += resid
      hess[0][0] += w
      for (let j = 0; j < d; j++) {
        grad[j + 1] += resid * X[i][j]
        hess[0][j + 1] += w * X[i][j]
        hess[j + 1][0] += w * X[i][j]
        for (let k = j; k < d; k++) {
          const v = w * X[i][j] * X[i][k]
          hess[j + 1][k + 1] += v
          if (k !== j) hess[k + 1][j + 1] += v
        }
      }
    }

    // L2 penalty on weights only (not the intercept).
    for (let j = 1; j <= d; j++) {
      grad[j] -= l2 * beta[j]
      hess[j][j] += l2
    }

    const step = solveLinearSystem(hess, grad)
    let maxStep = 0
    for (let j = 0; j <= d; j++) {
      beta[j] += step[j]
      maxStep = Math.max(maxStep, Math.abs(step[j]))
    }
    if (maxStep < tol) break
  }

  return { intercept: beta[0], weights: beta.slice(1) }
}

/** P(y=1 | features) under a stored model. Missing feature values read as 0. */
export function predictProba(
  coefficients: ModelCoefficients,
  features: Record<string, number>
): number {
  let z = coefficients.intercept
  for (const [name, beta] of Object.entries(coefficients.features)) {
    z += beta * (features[name] ?? 0)
  }
  return sigmoid(z)
}

/**
 * Rank-based AUC (Mann-Whitney U with average ranks for ties).
 * Returns 0.5 when either class is absent — no ranking is measurable.
 */
export function computeAuc(scores: number[], labels: number[]): number {
  const n = scores.length
  if (n === 0 || n !== labels.length) return 0.5

  const order = scores.map((s, i) => ({ s, y: labels[i] })).sort((a, b) => a.s - b.s)

  // Average ranks over tied score groups.
  const ranks = new Array<number>(n).fill(0)
  let i = 0
  while (i < n) {
    let j = i
    while (j + 1 < n && order[j + 1].s === order[i].s) j++
    const avgRank = (i + j) / 2 + 1 // 1-based
    for (let k = i; k <= j; k++) ranks[k] = avgRank
    i = j + 1
  }

  let nPos = 0
  let rankSumPos = 0
  for (let k = 0; k < n; k++) {
    if (order[k].y === 1) {
      nPos++
      rankSumPos += ranks[k]
    }
  }
  const nNeg = n - nPos
  if (nPos === 0 || nNeg === 0) return 0.5

  const u = rankSumPos - (nPos * (nPos + 1)) / 2
  return u / (nPos * nNeg)
}

/** Brier score — mean squared error of probabilities (lower is better). */
export function computeBrier(probs: number[], labels: number[]): number {
  const n = probs.length
  if (n === 0) return 0
  let sum = 0
  for (let i = 0; i < n; i++) sum += (probs[i] - labels[i]) ** 2
  return sum / n
}

export type CalibrationBin = {
  /** Inclusive lower / exclusive upper predicted-probability edge (last bin inclusive). */
  lower: number
  upper: number
  count: number
  meanPredicted: number
  actualRate: number
}

/** Equal-width reliability bins: predicted vs actual rate per probability decile. */
export function calibrationBins(probs: number[], labels: number[], n = 10): CalibrationBin[] {
  const bins: CalibrationBin[] = Array.from({ length: n }, (_, i) => ({
    lower: i / n,
    upper: (i + 1) / n,
    count: 0,
    meanPredicted: 0,
    actualRate: 0,
  }))

  for (let i = 0; i < probs.length; i++) {
    const idx = Math.min(Math.floor(probs[i] * n), n - 1)
    bins[idx].count++
    bins[idx].meanPredicted += probs[i]
    bins[idx].actualRate += labels[i]
  }

  for (const bin of bins) {
    if (bin.count > 0) {
      bin.meanPredicted = bin.meanPredicted / bin.count
      bin.actualRate = bin.actualRate / bin.count
    }
  }
  return bins
}

// ── Deterministic split ─────────────────────────────────────────────────────

/** mulberry32 — tiny seeded PRNG so train/test splits reproduce exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type TrainTestSplit = {
  trainX: number[][]
  trainY: number[]
  testX: number[][]
  testY: number[]
}

/** Seeded Fisher-Yates shuffle, then an 80/20 (default) split. */
export function trainTestSplit(
  X: number[][],
  y: number[],
  testFraction = 0.2,
  seed = 42
): TrainTestSplit {
  const n = X.length
  const indices = Array.from({ length: n }, (_, i) => i)
  const rand = mulberry32(seed)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[indices[i], indices[j]] = [indices[j], indices[i]]
  }

  const testSize = Math.max(1, Math.floor(n * testFraction))
  const testIdx = new Set(indices.slice(0, testSize))

  const split: TrainTestSplit = { trainX: [], trainY: [], testX: [], testY: [] }
  for (let i = 0; i < n; i++) {
    if (testIdx.has(i)) {
      split.testX.push(X[i])
      split.testY.push(y[i])
    } else {
      split.trainX.push(X[i])
      split.trainY.push(y[i])
    }
  }
  return split
}
