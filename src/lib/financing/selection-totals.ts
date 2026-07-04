import type { LenderSelection, SelectionTotals, CoverageLine } from './prequal-types'
import { buildCoverageLine } from './coverage-line'

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Compute live totals for an arbitrary lender selection (drives the interactive
 * "pick which lenders + terms to proceed with" UI). Each requested amount is
 * clamped to that lender's approved cap; each line uses the selected term.
 * Pure — safe to call on every checkbox/slider/term change.
 */
export function computeSelectionTotals(
  selections: LenderSelection[],
  treatmentTotal: number,
): SelectionTotals {
  const lines: CoverageLine[] = selections
    .map(({ offer, amount, term }) => {
      const clamped = Math.max(0, Math.min(amount, offer.approved_amount))
      return clamped > 0 ? buildCoverageLine(offer, clamped, term) : null
    })
    .filter((l): l is CoverageLine => l !== null)

  const total_loan = round2(lines.reduce((s, l) => s + l.amount, 0))
  const total_monthly = round2(lines.reduce((s, l) => s + l.monthly_payment, 0))
  const covered = Math.min(total_loan, treatmentTotal)

  return {
    lines,
    total_loan,
    total_monthly,
    covered,
    gap: round2(Math.max(0, treatmentTotal - total_loan)),
    selected_count: lines.length,
  }
}
