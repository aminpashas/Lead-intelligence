/**
 * Channel eligibility tally for a set of leads.
 *
 * A lead is reachable on a channel only with affirmative consent, no opt-out,
 * and a contact address. Exclusion reasons are mutually exclusive and checked in
 * priority order (opted_out > no_consent > no_contact), so the three buckets sum
 * to exactly `total - eligible`. Contact presence is a null-check on the address
 * column — it works on encrypted PII (a non-null ciphertext still means "has one").
 */

export type ChannelEligibility = {
  total: number
  eligible: number
  no_consent: number
  opted_out: number
  no_contact: number
}

export type LeadConsentRow = {
  sms_consent?: boolean | null
  sms_opt_out?: boolean | null
  email_consent?: boolean | null
  email_opt_out?: boolean | null
  phone_formatted?: string | null
  email?: string | null
}

export function computeEligibility(
  leads: LeadConsentRow[],
  channel: 'sms' | 'email'
): ChannelEligibility {
  const out: ChannelEligibility = {
    total: leads.length,
    eligible: 0,
    no_consent: 0,
    opted_out: 0,
    no_contact: 0,
  }
  for (const l of leads) {
    const consent = channel === 'sms' ? l.sms_consent === true : l.email_consent === true
    const optedOut = channel === 'sms' ? l.sms_opt_out === true : l.email_opt_out === true
    const hasContact = channel === 'sms' ? !!l.phone_formatted : !!l.email

    if (consent && !optedOut && hasContact) {
      out.eligible++
    } else if (optedOut) {
      out.opted_out++
    } else if (!consent) {
      out.no_consent++
    } else {
      out.no_contact++
    }
  }
  return out
}
