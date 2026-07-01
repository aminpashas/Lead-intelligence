/**
 * Resolve the Google Ads conversion-action resource name for an upload.
 *
 * The Google Ads API requires `conversionAction` to be a resource name of the
 * form `customers/{customerId}/conversionActions/{NUMERIC_ID}`. The previous
 * code fell back to `customers/{cid}/conversionActions/{conversionName}` where
 * `conversionName` is a human-readable LABEL ("Consultation Booked") — an
 * invalid resource name that the API rejects with a 4xx. Because the upload
 * swallowed that error, every OAuth-onboarded org's conversion forwarding
 * failed silently.
 *
 * This resolver returns a VALID resource name only when we actually have one:
 *   1. a real resource name persisted from OAuth onboarding, or
 *   2. a numeric conversion-action ID we can safely format.
 * Otherwise it returns null so the caller fails loudly with an actionable
 * message instead of POSTing a guaranteed-invalid guess.
 *
 * The full fix — auto-listing the customer's ConversionActions during OAuth and
 * persisting their resource names — is tracked separately; this stops the
 * silent-failure behavior in the meantime.
 */
export function resolveConversionActionResource(
  resourceName: string | null | undefined,
  customerId: string,
  conversionNameOrId: string | null | undefined
): string | null {
  // 1. A real resource name persisted from OAuth is authoritative.
  if (resourceName && resourceName.trim()) return resourceName.trim()

  // 2. A bare numeric conversion-action ID can be formatted into a resource name.
  const candidate = (conversionNameOrId ?? '').trim()
  if (/^\d+$/.test(candidate)) {
    return `customers/${customerId}/conversionActions/${candidate}`
  }

  // 3. A display-name label is NOT a valid resource id — don't guess.
  return null
}

/** Human-readable guidance when a conversion action can't be resolved. */
export function conversionActionError(eventType: string, conversionName: string | null | undefined): string {
  return (
    `Google Ads conversion for "${eventType}" is not configured: no conversion-action resource name ` +
    `and "${conversionName ?? '(none)'}" is a label, not a numeric conversion-action ID. ` +
    `Set the conversion action's resource name (customers/…/conversionActions/{id}) in the connector config.`
  )
}
