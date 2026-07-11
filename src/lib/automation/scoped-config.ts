import type { AutopilotConfig } from '@/lib/autopilot/config'
import type { AllocationDecision } from './allocation'

/**
 * Return a copy of `config` with the allocation's per-scope knobs applied.
 * A null knob inherits the org-level value already on `config`. Pure — never
 * mutates the input. An active-hours override also clears `config.schedule`
 * so the simpler [start, end) window governs the scoped decision.
 */
export function applyScopedKnobs(
  config: AutopilotConfig,
  decision: Pick<AllocationDecision, 'confidenceThreshold' | 'activeHoursStart' | 'activeHoursEnd'>
): AutopilotConfig {
  const next: AutopilotConfig = { ...config }
  if (decision.confidenceThreshold != null) next.confidence_threshold = decision.confidenceThreshold
  if (decision.activeHoursStart != null && decision.activeHoursEnd != null) {
    next.active_hours_start = decision.activeHoursStart
    next.active_hours_end = decision.activeHoursEnd
    next.schedule = null
  }
  return next
}
