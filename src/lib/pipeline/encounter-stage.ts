/**
 * Pure decision: which pipeline stage an encounter should advance a lead to,
 * or null to leave the stage unchanged. Monotonic — never moves a lead backward
 * (a >60s call on an already-Engaged lead must not drag them to Following Up).
 * The processor resolves the returned slug to this org's pipeline_stages.id.
 */
export type EncounterStageInput = {
  channel: 'sms' | 'email' | 'voice' | string
  inbound: boolean
  appointmentBooked: boolean
  durationSeconds: number | null
  currentStageSlug: string | null
}

// Funnel order for the stages this helper can assign. Higher = further along.
// `no-communication` is the un-worked intake queue (imported / non-paid leads
// land there — see lib/leads/intake-routing.ts). Funnel-wise it sits at the
// very start, so a reply or first outreach must lift a lead out of it exactly
// as it would out of `new`. Without this entry the guard in advanceTo() treats
// it as an "unknown/advanced" stage and never moves a lead that actually
// started talking — leaving a communicating lead stuck on "No Communication".
// The other operational stages (dnd-sms, nurturing) are deliberately absent:
// dnd-sms is a suppression state and nurturing has its own re-engagement flow.
const RANK: Record<string, number> = { 'no-communication': 0, new: 0, contacted: 1, engaged: 2, qualified: 3 }

export function nextStageForEncounter(input: EncounterStageInput): 'contacted' | 'engaged' | 'qualified' | null {
  const currentRank = input.currentStageSlug != null && input.currentStageSlug in RANK
    ? RANK[input.currentStageSlug]
    : -1 // unknown/further stage handled below

  // A booking is the strongest signal.
  if (input.appointmentBooked) return advanceTo('qualified', input.currentStageSlug, currentRank)

  // An inbound patient reply on a text/email channel → Engaged.
  if (input.inbound && (input.channel === 'sms' || input.channel === 'email')) {
    return advanceTo('engaged', input.currentStageSlug, currentRank)
  }

  // First meaningful outreach → Following Up (slug 'contacted'). A real (>60s)
  // voice call, or an outbound SMS/email, advances a brand-new lead only.
  const isOutreach =
    (input.channel === 'voice' && (input.durationSeconds ?? 0) > 60) ||
    ((input.channel === 'sms' || input.channel === 'email') && !input.inbound)
  if (isOutreach) return advanceTo('contacted', input.currentStageSlug, currentRank)

  return null
}

function advanceTo(
  target: 'contacted' | 'engaged' | 'qualified',
  currentStageSlug: string | null,
  currentRank: number,
): 'contacted' | 'engaged' | 'qualified' | null {
  // If the lead's current stage is unknown to RANK (e.g. already consultation-
  // scheduled or beyond), do NOT move it — only advance within the early funnel.
  if (currentStageSlug != null && !(currentStageSlug in RANK)) return null
  return RANK[target] > currentRank ? target : null
}
