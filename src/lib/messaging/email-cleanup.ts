/**
 * Cleanup for inbound/mirrored email bodies before we store or display them.
 *
 * GoHighLevel / LeadConnector delivers each marketing email with a per-recipient
 * unsubscribe footer, and the plaintext body GHL hands back renders that anchor
 * as `unsubscribe\n[https://services.msgsndr.com/emails/builder/unsubscribe-view/...token=<jwt>]`.
 * The `token` is GHL's OWN signed unsubscribe JWT (scope `preferences`) — not one
 * of our secrets — but unlinkified in the Conversations thread it shows up as a
 * wall of base64, which reads like a broken/garbled message. The email itself
 * already delivered with a working unsubscribe link, so the footer carries no
 * value once the message is in our thread: strip it for storage and display.
 *
 * The match is anchored on GHL's exact unsubscribe host+path so we never touch a
 * legitimate link a patient or staffer wrote. An optional preceding line that
 * mentions "unsubscribe" (GHL's "If you no longer wish to receive these emails
 * you may unsubscribe") is consumed too, so we don't leave a dangling sentence
 * whose link just vanished.
 */
const GHL_UNSUBSCRIBE_FOOTER =
  /\s*(?:[^\n]*\bunsubscribe\b[^\n]*\r?\n)?\s*\[?\s*https?:\/\/services\.msgsndr\.com\/emails\/builder\/unsubscribe-view\/[^\]\s]*\]?\s*$/i

/**
 * Remove GHL's trailing unsubscribe footer from an email body. Returns the body
 * unchanged when no GHL footer is present (SMS, social, our own emails, etc.),
 * so it is safe to call on any body.
 */
export function stripEmailUnsubscribeFooter(body: string | null | undefined): string {
  if (!body) return ''
  return body.replace(GHL_UNSUBSCRIBE_FOOTER, '').trimEnd()
}
