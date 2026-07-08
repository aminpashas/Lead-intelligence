import type { PipelineStage } from '@/types/database'

export type StageSuggestion = { toStageId: string; toStageName: string; reason: string }

/** The lead fields the suggester reads. */
export type StageSuggestionInput = {
  stage_id: string | null
  status: string
  consultation_date: string | null
  /** Intent signals — used to decide whether a low probability is EVIDENCE of
   *  low intent, or just missing data. Optional so callers can pass a full Lead. */
  ai_qualification?: string | null
  ai_score?: number | null
  total_messages_sent?: number | null
}

/**
 * True when we actually have something to score the lead on. A never-scored,
 * never-messaged lead's low probability just reflects absent data — not a signal
 * it belongs in nurture. Gating the nurture suggestion on this stops the board
 * from proposing "move to Nurturing" for every untouched import.
 */
function hasIntentSignal(lead: StageSuggestionInput): boolean {
  const scored =
    (lead.ai_score ?? 0) > 0 ||
    (lead.ai_qualification != null && lead.ai_qualification !== 'unscored')
  const engaged = (lead.total_messages_sent ?? 0) > 0
  return scored || engaged
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

  // 3. Very low probability → move to a nurture/dormant stage. Only when we
  // have real evidence of low intent — otherwise a fresh import with no score
  // and no messages would be blanket-nurtured on missing data alone.
  if (probability <= 0.12 && hasIntentSignal(lead)) {
    const s = propose(findStage(stages, /dormant|nurtur|cold/i), 'Low close probability — nurture')
    if (s) return s
  }

  return null
}
