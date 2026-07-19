/**
 * GHL opportunity-stage -> Lead Intelligence reconcile mapping.
 *
 * Each of the location's GHL pipelines has its OWN stage vocabulary, so this
 * folds all of them onto LI's canonical stages. Two operational GHL columns the
 * practice relies on are PRESERVED rather than collapsed:
 *   - "No Communication"  (kept as its own column)
 *   - "DND SMS"           (kept, and flags SMS suppression — email still allowed)
 *
 * Design rules (patient-safety first):
 *   - FAIL-SAFE: an unrecognised stage returns null. The reconcile SKIPS it and
 *     never resets the lead to "New Lead". A stage we don't understand must not
 *     silently drop a won/opted-out patient back into outreach.
 *   - Bare "Closed" (no won/lost qualifier — Full-Arch, Beverly Hills, Veneers)
 *     is disambiguated by the GHL opportunity `status` (won -> contract-signed,
 *     lost/abandoned -> lost).
 *   - "won"/"lost" targets carry suppressOutreach so the backfill can pull them
 *     out of any active outreach before touching anyone else.
 *
 * All logic is pure so the full 200+ -stage table is unit-testable without I/O.
 */

/** LI-native + preserved-GHL stage slugs the reconcile can assign. */
export type LiStageSlug =
  | 'new'
  | 'contacted'
  | 'engaged'
  | 'qualified'
  | 'consultation-scheduled'
  | 'consultation-completed'
  | 'treatment-presented'
  | 'financing'
  | 'contract-signed'
  | 'scheduled'
  | 'completed'
  | 'lost'
  | 'no-communication'
  | 'dnd-sms'
  | 'no-show'

export type ReconcileTarget = {
  stageSlug: LiStageSlug
  /** Won/lost/DND — drop out of active outreach on reconcile. */
  suppressOutreach?: boolean
  /** Opted out of SMS specifically (email still allowed). */
  smsDnd?: boolean
  /** Opted out of ALL channels (generic "Do Not Disturb"). */
  allChannelDnd?: boolean
}

/** GHL opportunity status, when present, disambiguates a bare "Closed" stage. */
export type GhlOppStatus = 'open' | 'won' | 'lost' | 'abandoned' | string | undefined

/** Normalize a stage name for lookup: lowercase, collapse whitespace, drop en/em dashes. */
export function normalizeStageName(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/[–—]/g, '-') // – — -> -
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The master table, keyed by normalized stage name. Names are shared across
 * pipelines where identical (e.g. "no communication" appears in 6 pipelines).
 * "closed" is intentionally ABSENT here — it is resolved via status below.
 */
const STAGE_TABLE: Record<string, ReconcileTarget> = {
  // ---- Won / accepted / in-treatment (suppress from lead outreach) ----
  'closed - accepted': { stageSlug: 'contract-signed', suppressOutreach: true },
  'accepted treatment': { stageSlug: 'contract-signed', suppressOutreach: true },
  'closed won': { stageSlug: 'contract-signed', suppressOutreach: true },
  'treatment started': { stageSlug: 'scheduled', suppressOutreach: true },
  'scheduled treatment': { stageSlug: 'scheduled', suppressOutreach: true },
  'completed': { stageSlug: 'completed', suppressOutreach: true },
  'financing provided': { stageSlug: 'financing' },

  // ---- Lost / not-interested / out-of-area (suppress) ----
  'not interested / disqualified': { stageSlug: 'lost', suppressOutreach: true },
  'not interested / lost': { stageSlug: 'lost', suppressOutreach: true },
  'closed lost': { stageSlug: 'lost', suppressOutreach: true },
  'lost': { stageSlug: 'lost', suppressOutreach: true },
  'out of area': { stageSlug: 'lost', suppressOutreach: true },
  'did not proceed with comp exam': { stageSlug: 'lost', suppressOutreach: true },

  // ---- Do-not-contact flags ----
  // DND SMS: keep the operational column, flag SMS suppression, email still OK.
  'dnd sms': { stageSlug: 'dnd-sms', smsDnd: true },
  // Generic "Do Not Disturb" (Beverly Hills): treat as all-channel suppression.
  'do not disturb': { stageSlug: 'lost', suppressOutreach: true, allChannelDnd: true },

  // ---- Appointment booked ----
  'appointment scheduled': { stageSlug: 'consultation-scheduled' },
  'booked appointment': { stageSlug: 'consultation-scheduled' },
  'scheduled virtual consult': { stageSlug: 'consultation-scheduled' },
  'lead contacted - appointment scheduled': { stageSlug: 'consultation-scheduled' },
  'virtual appointment': { stageSlug: 'consultation-scheduled' },

  // ---- Consult completed ----
  'in person consult done': { stageSlug: 'consultation-completed' },

  // ---- Treatment presented / plan on the table (keep active per practice) ----
  'treatment planned': { stageSlug: 'treatment-presented' },
  'treatment proposal': { stageSlug: 'treatment-presented' },
  'proposal/price quote': { stageSlug: 'treatment-presented' },
  'negotiation/review': { stageSlug: 'treatment-presented' },
  'requested vob': { stageSlug: 'treatment-presented' },
  // Stalled-but-active (user: keep active for re-engagement) ----
  'treatment plan not accepted': { stageSlug: 'treatment-presented' },
  'treatment planned / can\'t afford': { stageSlug: 'treatment-presented' },
  'denied financing': { stageSlug: 'financing' },

  // ---- Qualified ----
  'qualification': { stageSlug: 'qualified' },

  // ---- Contacted / actively worked / nurture attempts ----
  'active communication': { stageSlug: 'contacted' },
  'automated blast': { stageSlug: 'contacted' },
  'activated / but went cold': { stageSlug: 'contacted' },
  'nurturing campaign': { stageSlug: 'contacted' },
  'contacted': { stageSlug: 'contacted' },
  'contacted - no appointment': { stageSlug: 'contacted' },
  'follow up': { stageSlug: 'contacted' },
  'follow-up': { stageSlug: 'contacted' },
  'follow up needed': { stageSlug: 'contacted' },
  'follow-up needed': { stageSlug: 'contacted' },
  'follow up virtual (for pts who did not proceed on comp exam)': { stageSlug: 'contacted' },
  'did not move forward / follow up': { stageSlug: 'contacted' },
  'low interest / needs nurturing': { stageSlug: 'contacted' },
  'low interest/needs nurturing': { stageSlug: 'contacted' },
  'no show': { stageSlug: 'contacted' },
  'no showed to virtual': { stageSlug: 'contacted' },
  'botox only': { stageSlug: 'contacted' },
  'sleep study performed': { stageSlug: 'contacted' },
  '1st call': { stageSlug: 'contacted' },
  '2nd call': { stageSlug: 'contacted' },
  '3rd call': { stageSlug: 'contacted' },
  '5th call': { stageSlug: 'contacted' },
  '2nd attempt': { stageSlug: 'contacted' },
  '3rd attempt': { stageSlug: 'contacted' },
  '4th attempt': { stageSlug: 'contacted' },
  '5th attempt': { stageSlug: 'contacted' },
  '6th attempt': { stageSlug: 'contacted' },
  '7th attempt': { stageSlug: 'contacted' },
  '1-month attempt': { stageSlug: 'contacted' },
  '1 month attempt': { stageSlug: 'contacted' },
  '1-month follow-up': { stageSlug: 'contacted' },
  '2-week attempt': { stageSlug: 'contacted' },
  '14th day attempt': { stageSlug: 'contacted' },
  'call, text, email day 4': { stageSlug: 'contacted' },

  // ---- Preserved operational column ----
  'no communication': { stageSlug: 'no-communication' },

  // ---- Genuinely fresh ----
  'new lead': { stageSlug: 'new' },
  'aox leads': { stageSlug: 'new' },
  'aox lead': { stageSlug: 'new' },
  'received': { stageSlug: 'new' },
  'newsletter': { stageSlug: 'new' },
}

/**
 * Resolve a GHL (stage, status) to a reconcile target, or null when the stage
 * is unrecognised (caller SKIPS — never resets to New Lead).
 */
export function resolveReconcileTarget(
  stageName: string | undefined,
  status?: GhlOppStatus,
): ReconcileTarget | null {
  const key = normalizeStageName(stageName ?? '')
  if (!key) return null

  // Bare "Closed" — disambiguate by opportunity status.
  if (key === 'closed') {
    if (status === 'won') return { stageSlug: 'contract-signed', suppressOutreach: true }
    if (status === 'lost' || status === 'abandoned') return { stageSlug: 'lost', suppressOutreach: true }
    return null // open/unknown "Closed" is ambiguous — don't guess.
  }

  return STAGE_TABLE[key] ?? null
}
