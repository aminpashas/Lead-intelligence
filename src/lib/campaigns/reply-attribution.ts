/**
 * Attribute a lead's reply to the campaign step(s) that were engaging it.
 *
 * `campaign_steps.total_replied` was read by campaign analytics and the
 * reactivation funnel but never written. When a lead replies we credit the step
 * the lead is currently on in each active enrollment. Pure + unit-tested; the
 * caller applies the returned increments and guards on first-reply-only so a
 * chatty lead can't inflate the counter.
 */
export function computeReplyStepIncrements(
  enrollments: Array<{ campaign_id: string; current_step: number | null }>,
  steps: Array<{ id: string; campaign_id: string; step_number: number; total_replied: number | null }>
): Array<{ id: string; total_replied: number }> {
  const out: Array<{ id: string; total_replied: number }> = []
  const seenSteps = new Set<string>()
  for (const e of enrollments) {
    const step = steps.find(
      (s) => s.campaign_id === e.campaign_id && s.step_number === (e.current_step ?? 0)
    )
    if (step && !seenSteps.has(step.id)) {
      seenSteps.add(step.id)
      out.push({ id: step.id, total_replied: (step.total_replied ?? 0) + 1 })
    }
  }
  return out
}
