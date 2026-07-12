/**
 * Workstream B2: per-provider monthly enrichment budget tests.
 */

import { describe, it, expect } from 'vitest'
import {
  resolveMonthlyBudgets,
  overBudgetTypes,
  budgetConfigOverride,
  monthStartIso,
} from '../budgets'

describe('resolveMonthlyBudgets', () => {
  it('uses defaults when env is empty', () => {
    const budgets = resolveMonthlyBudgets({})
    expect(budgets.experian_consumer).toBe(2000)
    expect(budgets.email_validation).toBe(5000)
    expect(budgets.website_behavior).toBe(50000)
  })

  it('honors env overrides and ignores garbage values', () => {
    const budgets = resolveMonthlyBudgets({
      ENRICH_BUDGET_EXPERIAN: '150',
      ENRICH_BUDGET_EMAIL: 'not-a-number',
      ENRICH_BUDGET_PHONE: '-5',
    })
    expect(budgets.experian_consumer).toBe(150)
    expect(budgets.email_validation).toBe(5000) // fallback
    expect(budgets.phone_validation).toBe(5000) // negative rejected → fallback
  })
})

describe('overBudgetTypes / budgetConfigOverride', () => {
  it('flags providers at or over budget and builds a disable override', () => {
    const budgets = resolveMonthlyBudgets({ ENRICH_BUDGET_EXPERIAN: '100', ENRICH_BUDGET_EMAIL: '10' })
    const exceeded = overBudgetTypes(
      { experian_consumer: 100, email_validation: 3, phone_validation: 0 },
      budgets
    )
    expect(exceeded).toEqual(['experian_consumer'])

    const override = budgetConfigOverride(exceeded)
    expect(override).toEqual({ experian_consumer: { enabled: false } })
  })

  it('treats missing counts as zero', () => {
    const budgets = resolveMonthlyBudgets({})
    expect(overBudgetTypes({}, budgets)).toEqual([])
  })
})

describe('monthStartIso', () => {
  it('returns the first UTC instant of the month', () => {
    expect(monthStartIso(new Date('2026-07-11T15:30:00Z'))).toBe('2026-07-01T00:00:00.000Z')
    expect(monthStartIso(new Date('2026-01-01T00:00:01Z'))).toBe('2026-01-01T00:00:00.000Z')
  })
})
