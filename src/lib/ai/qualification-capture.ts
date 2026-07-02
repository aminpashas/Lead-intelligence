/**
 * Qualification Capture
 *
 * Turns what the setter LEARNED in a conversation (goal, financing stance, credit
 * bucket, timeline) into structured lead fields, then re-grades lead quality when
 * that genuinely adds new information. This is the "filter leads + assign quality"
 * loop: discovery answers → columns → fresh Hot/Warm/Cold score.
 *
 * Design choices:
 *  - Validate every value against its enum. The model can misremember; we never
 *    write junk into a CHECK-constrained column.
 *  - Clinical/financing fields are FILL-WHEN-MISSING so a conversational misread
 *    can't clobber data the patient gave on the intake form. Credit + timeline are
 *    conversation-native, so the latest clearly-stated value wins.
 *  - Only re-score when at least one field actually changed — re-scoring calls
 *    Claude, so we don't pay for it on every message.
 *  - Fully best-effort: the setter wraps this in .catch(); a capture/scoring
 *    hiccup must never break the live reply.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Lead, DentalCondition, FinancingInterest, CreditRange } from '@/types/database'
import { rescoreAndPersistLead } from './scoring'

const DENTAL_CONDITIONS: readonly DentalCondition[] = [
  'missing_all_upper', 'missing_all_lower', 'missing_all_both',
  'missing_multiple', 'failing_teeth', 'denture_problems', 'other',
]
const FINANCING_INTERESTS: readonly FinancingInterest[] = [
  'cash_pay', 'financing_needed', 'insurance_only', 'undecided',
]
// 'unknown' is intentionally excluded — it means "no info", not a captured value.
const CREDIT_RANGES: readonly CreditRange[] = ['excellent', 'good', 'fair', 'rebuilding']

/** Lower/trim a model-supplied token; treat null-ish strings as absent. */
function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim().toLowerCase()
  if (!v || v === 'null' || v === 'unknown' || v === 'none' || v === 'n/a') return undefined
  return v
}

export type CapturedQualification = {
  dental_condition?: string | null
  financing_interest?: string | null
  credit_range?: string | null
  timeline_note?: string | null
}

export async function captureQualificationFromResponse(
  supabase: SupabaseClient,
  params: {
    lead: Partial<Lead>
    organization_id: string
    captured?: CapturedQualification
  }
): Promise<void> {
  const { lead, organization_id, captured } = params
  if (!captured || !lead?.id) return

  const updates: Partial<Lead> = {}

  // Goal / clinical picture — respect existing (form-supplied) data.
  const dc = clean(captured.dental_condition)
  if (dc && (DENTAL_CONDITIONS as readonly string[]).includes(dc) && !lead.dental_condition) {
    updates.dental_condition = dc as DentalCondition
  }

  // Financing stance — respect existing data.
  const fi = clean(captured.financing_interest)
  if (fi && (FINANCING_INTERESTS as readonly string[]).includes(fi) && !lead.financing_interest) {
    updates.financing_interest = fi as FinancingInterest
  }

  // Credit bucket — conversation is the source of truth; update when it changed.
  const cr = clean(captured.credit_range)
  if (cr && (CREDIT_RANGES as readonly string[]).includes(cr) && cr !== lead.credit_range) {
    updates.credit_range = cr as CreditRange
  }

  // Stated timeline — free text; store the latest, bounded.
  const rawTimeline = typeof captured.timeline_note === 'string' ? captured.timeline_note.trim() : ''
  if (rawTimeline && rawTimeline !== lead.timeline_note) {
    updates.timeline_note = rawTimeline.slice(0, 280)
  }

  if (Object.keys(updates).length === 0) return // nothing new learned → no write, no re-score

  await supabase.from('leads').update(updates).eq('id', lead.id)

  // Re-grade against the merged view so the new signals move the score.
  await rescoreAndPersistLead(supabase, { ...lead, ...updates, id: lead.id, organization_id })
}
