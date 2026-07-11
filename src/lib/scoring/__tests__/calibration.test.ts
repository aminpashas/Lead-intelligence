import { describe, it, expect } from 'vitest'
import {
  fitLogistic,
  predictProba,
  computeAuc,
  computeBrier,
  calibrationBins,
  trainTestSplit,
  mulberry32,
  type ModelCoefficients,
} from '../calibration'
import { buildFeatureVector, featureNames, labelLeadOutcome, type FeatureInput } from '../features'

/** Synthetic data with known generating coefficients. */
function makeSynthetic(n: number, trueIntercept: number, trueWeights: number[], seed = 7) {
  const rand = mulberry32(seed)
  const d = trueWeights.length
  const X: number[][] = []
  const y: number[] = []
  for (let i = 0; i < n; i++) {
    const row = Array.from({ length: d }, () => rand())
    let z = trueIntercept
    for (let j = 0; j < d; j++) z += trueWeights[j] * row[j]
    const p = 1 / (1 + Math.exp(-z))
    X.push(row)
    y.push(rand() < p ? 1 : 0)
  }
  return { X, y }
}

describe('fitLogistic', () => {
  it('recovers known generating coefficients within tolerance', () => {
    const trueIntercept = -1.0
    const trueWeights = [2.0, -1.5, 0.8]
    const { X, y } = makeSynthetic(8000, trueIntercept, trueWeights)

    const fit = fitLogistic(X, y, { l2: 0.01 })

    expect(fit.intercept).toBeCloseTo(trueIntercept, 0)
    expect(Math.abs(fit.intercept - trueIntercept)).toBeLessThan(0.35)
    for (let j = 0; j < trueWeights.length; j++) {
      expect(Math.abs(fit.weights[j] - trueWeights[j])).toBeLessThan(0.35)
    }
  })

  it('is deterministic across repeat fits', () => {
    const { X, y } = makeSynthetic(500, 0.5, [1.0, -1.0])
    const a = fitLogistic(X, y)
    const b = fitLogistic(X, y)
    expect(a.intercept).toBe(b.intercept)
    expect(a.weights).toEqual(b.weights)
  })

  it('achieves AUC > 0.9 on separable data', () => {
    // Strongly separable: one feature almost fully determines the label.
    const rand = mulberry32(11)
    const X: number[][] = []
    const y: number[] = []
    for (let i = 0; i < 1000; i++) {
      const label = i % 2
      // Positive class clusters near 0.9, negative near 0.1 (small overlap noise).
      const x0 = label === 1 ? 0.75 + rand() * 0.25 : rand() * 0.25
      X.push([x0, rand()])
      y.push(label)
    }
    const fit = fitLogistic(X, y)
    const coefficients: ModelCoefficients = {
      intercept: fit.intercept,
      features: { a: fit.weights[0], b: fit.weights[1] },
    }
    const scores = X.map((row) => predictProba(coefficients, { a: row[0], b: row[1] }))
    expect(computeAuc(scores, y)).toBeGreaterThan(0.9)
  })
})

describe('predictProba', () => {
  const model: ModelCoefficients = { intercept: -1, features: { x: 3 } }

  it('is monotonic in a positively weighted feature', () => {
    let prev = -Infinity
    for (let x = 0; x <= 1.0001; x += 0.1) {
      const p = predictProba(model, { x })
      expect(p).toBeGreaterThan(prev)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(1)
      prev = p
    }
  })

  it('treats missing features as 0 and returns sigmoid(intercept)', () => {
    expect(predictProba(model, {})).toBeCloseTo(1 / (1 + Math.exp(1)), 10)
  })
})

describe('computeAuc', () => {
  it('is 1 for perfectly ranked scores and 0.5 for a single class', () => {
    expect(computeAuc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1])).toBe(1)
    expect(computeAuc([0.1, 0.9], [1, 1])).toBe(0.5)
  })

  it('handles ties with average ranks', () => {
    // All scores tied → chance-level 0.5.
    expect(computeAuc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1])).toBe(0.5)
  })
})

describe('computeBrier', () => {
  it('is 0 for perfect probabilities and 1 for maximally wrong ones', () => {
    expect(computeBrier([0, 1], [0, 1])).toBe(0)
    expect(computeBrier([1, 0], [0, 1])).toBe(1)
  })
})

describe('calibrationBins', () => {
  it('produces sane bins: counts sum to n, well-calibrated probs match actuals', () => {
    // Probabilities that ARE the actual rates: p of the points labeled 1.
    const rand = mulberry32(3)
    const probs: number[] = []
    const labels: number[] = []
    for (let i = 0; i < 5000; i++) {
      const p = rand()
      probs.push(p)
      labels.push(rand() < p ? 1 : 0)
    }
    const bins = calibrationBins(probs, labels, 10)

    expect(bins).toHaveLength(10)
    expect(bins.reduce((s, b) => s + b.count, 0)).toBe(5000)
    for (const bin of bins) {
      expect(bin.lower).toBeLessThan(bin.upper)
      if (bin.count > 100) {
        // Calibrated data: per-bin actual rate tracks mean predicted.
        expect(Math.abs(bin.actualRate - bin.meanPredicted)).toBeLessThan(0.12)
        expect(bin.meanPredicted).toBeGreaterThanOrEqual(bin.lower)
        expect(bin.meanPredicted).toBeLessThanOrEqual(bin.upper)
      }
    }
  })
})

describe('trainTestSplit', () => {
  it('is deterministic for the same seed and splits 80/20 without overlap or loss', () => {
    const X = Array.from({ length: 100 }, (_, i) => [i])
    const y = Array.from({ length: 100 }, (_, i) => i % 2)

    const a = trainTestSplit(X, y, 0.2, 42)
    const b = trainTestSplit(X, y, 0.2, 42)
    expect(a.testX).toEqual(b.testX)
    expect(a.trainX).toEqual(b.trainX)

    expect(a.testX).toHaveLength(20)
    expect(a.trainX).toHaveLength(80)
    const seen = new Set([...a.trainX, ...a.testX].map((r) => r[0]))
    expect(seen.size).toBe(100)

    const c = trainTestSplit(X, y, 0.2, 43)
    expect(c.testX).not.toEqual(a.testX)
  })
})

describe('buildFeatureVector', () => {
  const NOW = Date.parse('2026-07-11T00:00:00Z')

  const baseLead: FeatureInput = {
    ai_score: 80,
    ai_qualification: 'hot',
    total_messages_sent: 4,
    total_messages_received: 3,
    financing_interest: 'cash_pay',
    treatment_value: 25000,
    no_show_count: 1,
    created_at: new Date(NOW - 10 * 86_400_000).toISOString(),
    conversation_intent: 'ready_to_book',
    enrichment_score: 60,
    gclid: 'abc',
    fbclid: null,
    utm_medium: null,
  }

  it('produces every declared feature, all in 0..1', () => {
    const f = buildFeatureVector(baseLead, undefined, NOW)
    for (const name of featureNames) {
      expect(f[name]).toBeGreaterThanOrEqual(0)
      expect(f[name]).toBeLessThanOrEqual(1)
    }
    expect(f.ai_score).toBe(0.8)
    expect(f.qual_hot).toBe(1)
    expect(f.qual_warm).toBe(0)
    expect(f.response_rate).toBe(0.75)
    expect(f.financing_cash_pay).toBe(1)
    expect(f.has_treatment_value).toBe(1)
    expect(f.intent_ready_to_book).toBe(1)
    expect(f.identity_confidence).toBe(0.6)
    expect(f.source_paid).toBe(1)
  })

  it('falls back to neutral identity confidence when never enriched', () => {
    const f = buildFeatureVector({ ...baseLead, enrichment_score: 0 }, undefined, NOW)
    expect(f.identity_confidence).toBe(0.5)
  })

  it('prefers a supplied enrichment summary over the persisted score', () => {
    const f = buildFeatureVector(baseLead, { identity_confidence: 90 }, NOW)
    expect(f.identity_confidence).toBe(0.9)
  })
})

describe('labelLeadOutcome', () => {
  const NOW = Date.parse('2026-07-11T00:00:00Z')
  const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString()

  it('labels converted, terminal-negative, stale, and open leads', () => {
    const open = { converted_at: null, status: 'contacted' as const, created_at: daysAgo(5), last_contacted_at: daysAgo(1) }
    expect(labelLeadOutcome({ ...open, converted_at: daysAgo(2) }, NOW)).toBe(1)
    expect(labelLeadOutcome({ ...open, status: 'contract_signed' }, NOW)).toBe(1)
    expect(labelLeadOutcome({ ...open, status: 'lost' }, NOW)).toBe(0)
    expect(labelLeadOutcome({ ...open, status: 'disqualified' }, NOW)).toBe(0)
    expect(
      labelLeadOutcome({ converted_at: null, status: 'contacted', created_at: daysAgo(200), last_contacted_at: daysAgo(120) }, NOW)
    ).toBe(0)
    expect(labelLeadOutcome(open, NOW)).toBeNull()
    // Old lead touched recently is still open, not stale.
    expect(
      labelLeadOutcome({ converted_at: null, status: 'contacted', created_at: daysAgo(200), last_contacted_at: daysAgo(3) }, NOW)
    ).toBeNull()
  })
})
