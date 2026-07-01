import type { PipelineStage } from '@/types/database'

export type StageSuggestion = { toStageId: string; toStageName: string; reason: string }

/** The lead fields the suggester reads. */
export type StageSuggestionInput = {
  stage_id: string | null
  status: string
  consultation_date: string | null
}

function findStage(stages: PipelineStage[], re: RegExp): PipelineStage | undefined {
  return stages.find(
    (s) => !s.is_won && !s.is_lost && (re.test(s.slug ?? '') || re.test(s.name ?? ''))
  )
}

/**
 * Suggest a pipeline stage move from behavior + close probability, or null when
 * nothing should change. This never moves a lead — it only proposes a move for
 * one-click human approval. Thresholds are conservative defaults; tune per practice.
 */
export function suggestStageMove(
  lead: StageSuggestionInput,
  probability: number,
  stages: PipelineStage[]
): StageSuggestion | null {
  const current = stages.find((s) => s.id === lead.stage_id)
  // Never move a lead already parked in a won/lost stage.
  if (current && (current.is_won || current.is_lost)) return null

  const propose = (target: PipelineStage | undefined, reason: string): StageSuggestion | null => {
    if (!target || target.id === lead.stage_id) return null
    return { toStageId: target.id, toStageName: target.name, reason }
  }

  // 1. Booked a consultation → the consult/scheduled stage.
  if (lead.consultation_date || lead.status === 'consultation_scheduled') {
    const s = propose(findStage(stages, /consult|schedul/i), 'Consultation booked')
    if (s) return s
  }

  // 2. High close probability → advance to the qualified stage (forward only).
  if (probability >= 0.65) {
    const target = findStage(stages, /qualif/i)
    if (target && (!current || target.position > current.position)) {
      return propose(target, `High close probability (${Math.round(probability * 100)}%)`)
    }
  }

  // 3. Very low probability → move to a nurture/dormant stage.
  if (probability <= 0.12) {
    const s = propose(findStage(stages, /dormant|nurtur|cold/i), 'Low close probability — nurture')
    if (s) return s
  }

  return null
}
