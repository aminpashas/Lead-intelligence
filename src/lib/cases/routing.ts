/**
 * Case routing — derives the two cross-app hand-off states a clinical case has
 * once it leaves Lead Intelligence's funnel:
 *
 *   • Lab  → Smile Design Lab (records/design/manufacturing). Two-way: LI submits
 *            the case + files and SDL pushes `case.status_changed` back, which the
 *            SDL webhook stores in lab_orders.status. So this reflects LIVE state.
 *   • Surgery → Dion Clinical (surgery scheduling / chart). Currently a one-way
 *            hand-off: LI emits `case.treatment_agreed`; until the Dion read-back
 *            loop lands (Phase 4), the strongest honest signal is "handed off".
 *            dion_surgery_status/date are populated once the read-back exists.
 *
 * Pure + presentation-agnostic so the board card and the case-detail Routing
 * section render from one source of truth.
 */
import type { ClinicalCase, LabOrderStatus } from '@/types/database'

export type LabRoutingState =
  | 'not_sent' | 'submitted' | 'in_production' | 'shipped' | 'delivered' | 'issue'

export type LabRouting = {
  state: LabRoutingState
  label: string
  /** SDL human case number (SDL-YYYY-NNNNNN) once submitted. */
  externalNumber: string | null
  /** Deep link into SDL's doctor view, when we know the SDL web origin + case id. */
  deepLink: string | null
  /** true once the case has been sent to the lab at all. */
  active: boolean
}

export type SurgeryRoutingState = 'not_routed' | 'handed_off' | 'scheduled' | 'completed'

export type SurgeryRouting = {
  state: SurgeryRoutingState
  label: string
  /** Surgery date (YYYY-MM-DD) — from LI closing, or read back from Dion Clinical. */
  date: string | null
  active: boolean
}

/** Map the raw SDL lab_orders.status → a coarse, display-friendly lab state. */
function labStateFromStatus(status: LabOrderStatus): LabRoutingState {
  switch (status) {
    case 'draft':
    case 'submitted':
    case 'accepted':
      return 'submitted'
    case 'design_review':
    case 'manufacturing':
      return 'in_production'
    case 'shipped':
      return 'shipped'
    case 'delivered':
    case 'completed':
      return 'delivered'
    case 'declined':
    case 'cancelled':
    case 'error':
      return 'issue'
    default:
      return 'submitted'
  }
}

const LAB_LABELS: Record<LabRoutingState, string> = {
  not_sent: 'Not sent to lab',
  submitted: 'Sent to lab',
  in_production: 'In production',
  shipped: 'Shipped',
  delivered: 'Delivered',
  issue: 'Lab issue',
}

export function deriveLabRouting(c: ClinicalCase, sdlWebBase?: string | null): LabRouting {
  const order = c.lab_order ?? null
  if (!order || order.lab_provider !== 'smile_design_lab') {
    return { state: 'not_sent', label: LAB_LABELS.not_sent, externalNumber: null, deepLink: null, active: false }
  }
  const state = labStateFromStatus(order.status)
  const deepLink =
    sdlWebBase && order.external_case_id
      ? `${sdlWebBase.replace(/\/$/, '')}/doctor/cases/${order.external_case_id}`
      : null
  return {
    state,
    label: LAB_LABELS[state],
    externalNumber: order.external_case_number,
    deepLink,
    active: true,
  }
}

const SURGERY_LABELS: Record<SurgeryRoutingState, string> = {
  not_routed: 'Not routed',
  handed_off: 'Handed to clinical',
  scheduled: 'Surgery scheduled',
  completed: 'Surgery complete',
}

/**
 * Surgery routing precedence (most-progressed wins):
 *   completed   — LI case completed, or Dion reports a completed appointment
 *   scheduled   — Dion read-back says scheduled, OR LI closing has a surgery_date
 *   handed_off  — case.treatment_agreed was delivered (dion_handoff_at set)
 *   not_routed  — nothing yet
 */
export function deriveSurgeryRouting(c: ClinicalCase): SurgeryRouting {
  const closing = c.closing ?? null
  const dionStatus = closing?.dion_surgery_status ?? null
  const surgeryDate = closing?.dion_surgery_date ?? closing?.surgery_date ?? null

  const isCompleted =
    c.status === 'completed' || dionStatus === 'completed'
  const isScheduled =
    dionStatus === 'scheduled' ||
    c.status === 'surgery_scheduled' ||
    c.status === 'ready_for_surgery' ||
    !!closing?.surgery_date
  const isHandedOff = !!closing?.dion_handoff_at

  let state: SurgeryRoutingState = 'not_routed'
  if (isCompleted) state = 'completed'
  else if (isScheduled) state = 'scheduled'
  else if (isHandedOff) state = 'handed_off'

  return {
    state,
    label: SURGERY_LABELS[state],
    date: surgeryDate,
    active: state !== 'not_routed',
  }
}
