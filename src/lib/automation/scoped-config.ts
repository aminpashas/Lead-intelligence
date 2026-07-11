import type { AutopilotConfig } from '@/lib/autopilot/config'
import type { AllocationDecision } from './allocation'

/**
 * Return a copy of `config` with the allocation's per-scope knobs applied.
 * A null knob inherits the org-level value already on `config`. Pure — never
 * mutates the input.
 */
export function applyScopedKnobs(
  config: AutopilotConfig,
  decision: Pick<AllocationDecision, 'confidenceThreshold' | 'activeHoursStart' | 'activeHoursEnd'>
): AutopilotConfig {
  const next: AutopilotConfig = { ...config }
  if (decision.confidenceThreshold != null) next.confidence_threshold = decision.confidenceThreshold
  // Scoped simple-hours apply only when the org uses a simple window (no
  // day-of-week schedule). We never null an existing schedule — that would
  // silently discard the org's day disables (e.g. "no autopilot Sunday").
  if (
    config.schedule == null &&
    decision.activeHoursStart != null &&
    decision.activeHoursEnd != null
  ) {
    next.active_hours_start = decision.activeHoursStart
    next.active_hours_end = decision.activeHoursEnd
  }
  return next
}
