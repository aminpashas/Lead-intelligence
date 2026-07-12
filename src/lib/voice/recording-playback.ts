/**
 * Where the browser should stream a call recording from.
 *
 * Retell recording URLs are public and browser-fetchable, so they play
 * directly. Twilio recording URLs (browser-softphone conference recordings)
 * live on api.twilio.com and require account credentials — the <audio> tag
 * can't attach Basic auth, so those route through our authenticated proxy
 * (/api/voice/recording/[id]), which also keeps the raw Twilio URL out of
 * the client. Client-safe: pure string logic, no secrets.
 */
export function recordingPlaybackUrl(callId: string, recordingUrl: string | null | undefined): string | null {
  if (!recordingUrl) return null
  return isTwilioRecordingUrl(recordingUrl) ? `/api/voice/recording/${callId}` : recordingUrl
}

export function isTwilioRecordingUrl(url: string): boolean {
  return /^https?:\/\/api\.twilio\.com\//i.test(url)
}
