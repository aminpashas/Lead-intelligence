/**
 * Minimal best-effort Slack alert to the global SLACK_WEBHOOK_URL incoming webhook.
 * No-op when the env is unset; never throws (an alert failure must not break the
 * caller). Shared by ops-digest, the A2P status monitor, and future alert paths.
 */
export async function postSlack(text: string): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL
  if (!url) return
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000),
    })
  } catch (err) {
    console.warn('[slack] alert failed', err)
  }
}
