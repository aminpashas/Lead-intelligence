import type { ConsultOutcome, LeadStatus } from '@/types/database'

export type { ConsultOutcome, ConsultOutcomeReason } from '@/types/database'

/** Map a recorded consult outcome to the lead's pipeline status. */
export function outcomeToLeadStatus(outcome: ConsultOutcome): LeadStatus {
  switch (outcome) {
    case 'treatment_accepted': return 'treatment_presented'
    case 'deposit_paid':       return 'financing'
    case 'considering':        return 'consultation_completed'
    case 'no_decision':        return 'consultation_completed'
    case 'declined':           return 'lost'
    case 'referred_out':       return 'disqualified'
  }
}
