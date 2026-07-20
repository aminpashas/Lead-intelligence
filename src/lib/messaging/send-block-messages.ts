// Human-readable copy for the structured block/failure `reason` that
// /api/sms/send and /api/email/send return on a refused send (HTTP 403/4xx).
// The send is refused BEFORE Twilio/Resend by the consent gate, quiet-hours,
// compliance, or A2P 10DLC checks — so these explain *why nothing was sent*
// rather than a generic "failed".
//
// Keep in sync with:
//   - ConsentDenyReason  (src/lib/consent/gate.ts)
//   - the reasons returned in src/lib/messaging/twilio.ts
//
// Client-safe: pure data + a formatter, no server imports.
export const SEND_BLOCK_MESSAGES: Record<string, string> = {
  no_consent: 'Blocked: this lead hasn’t consented to messaging (TCPA). Capture consent before sending.',
  opted_out: 'Blocked: this lead has opted out. You cannot message them.',
  do_not_call: 'Blocked: this lead is marked Do Not Contact.',
  quiet_hours: 'Blocked: outside TCPA quiet hours (8am–9pm in the lead’s timezone).',
  compliance_blocked: 'Blocked: the message failed the compliance filter.',
  compliance_review_required: 'Held for review: the message needs compliance approval before sending.',
  us_sms_disabled: 'Blocked: US A2P 10DLC SMS is not enabled for this org.',
  lead_not_found: 'Could not send: lead not found.',
  lookup_failed: 'Could not send: lead lookup failed. Try again.',
  on_hold: 'Blocked: this lead is on hold.',
  // Meta blocks free-form Page→user messages more than 24h after the contact's
  // last inbound message. Not our gate and not fixable by retrying — the lead
  // has to message first, so the only useful next step is another channel.
  social_window_closed:
    'Not sent: Meta only allows replies within 24 hours of the lead’s last message. They’ll need to message you again — try SMS, email, or a call instead.',
}

/**
 * Resolve a failed-send response body to a user-facing message. Prefers the
 * mapped copy for a known `reason`, then the server's raw `error` string, then
 * the caller's generic fallback.
 */
export function sendBlockMessage(
  data: { reason?: unknown; error?: unknown } | null | undefined,
  fallback: string,
): string {
  const reason = typeof data?.reason === 'string' ? data.reason : undefined
  if (reason && SEND_BLOCK_MESSAGES[reason]) return SEND_BLOCK_MESSAGES[reason]
  if (typeof data?.error === 'string' && data.error) return data.error
  return fallback
}
