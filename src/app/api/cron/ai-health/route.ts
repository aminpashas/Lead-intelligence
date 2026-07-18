/**
 * AI health canary — every 15 min.
 *
 * WHY THIS EXISTS: on 2026-07-14/15 the Anthropic account hit its monthly usage
 * cap and every agent call started returning 400. The system detected it (each
 * inbound filed an escalation) but nothing alerted for ~2 days, because the only
 * outage signals were passive — they required a patient to text in first, and the
 * daily ops-digest's delivery channels were unconfigured. A live patient message
 * ("I can't make it") was lost as a result.
 *
 * This canary makes outage detection ACTIVE and fast: it makes one tiny real call
 * to the exact production model on the exact production key, on a 15-min cadence,
 * independent of whether any patient happens to be messaging. On the healthy→down
 * transition it posts to Slack; on down→healthy it posts a recovery note.
 *
 * The probe is deliberately the real thing (not a mock) — a mocked check would not
 * have caught a billing cap, an auth failure, a retired model, or a provider 5xx,
 * which are exactly the failure modes that take all AI down. Cost is ~15 tokens
 * per run (a few cents/month).
 *
 * Delivery uses SLACK_WEBHOOK_URL — the SAME env var the daily ops-digest already
 * expects — so setting that one var in prod lights up both this canary and the
 * digest. If it is unset the canary still detects and records the outage to
 * cron_runs (visible to getCronHealth / ops-digest); it just can't push Slack.
 */

import Anthropic from '@anthropic-ai/sdk'
import { withCron, type CronOutcome } from '@/lib/cron/with-cron'
import type { createServiceClient } from '@/lib/supabase/server'

type ServiceClient = ReturnType<typeof createServiceClient>

// The model the scoring + agent paths actually use. Probing this exact id means a
// retired-model 404 (a real past outage) would trip the canary too.
const PROBE_MODEL = 'claude-sonnet-4-6'

// Re-alerting during a sustained outage is intentionally left to the daily
// ops-digest + the per-message 'urgent' escalations; this canary alerts only on
// the state TRANSITIONS so a multi-hour outage doesn't post every 15 minutes.
async function previousRunFailed(supabase: ServiceClient): Promise<boolean> {
  const { data } = await supabase
    .from('cron_runs')
    .select('status')
    .eq('cron', 'ai-health')
    .order('ran_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data?.status === 'failed'
}

async function postSlack(text: string): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL
  if (!url) return // detection still recorded to cron_runs; nothing to push to
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000),
    })
  } catch (err) {
    console.warn('[ai-health] slack post failed', err)
  }
}

export const POST = withCron('ai-health', async ({ supabase }): Promise<CronOutcome> => {
  const wasDown = await previousRunFailed(supabase)

  try {
    await new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }).messages.create({
      model: PROBE_MODEL,
      max_tokens: 4,
      messages: [{ role: 'user', content: 'ping' }],
    })
  } catch (err) {
    // Any Anthropic.APIError = the AI is unusable for everyone (billing cap,
    // credits, auth, retired model, provider 5xx). A non-APIError (network blip)
    // is recorded but not alerted, to avoid paging on transient noise.
    const isOutage = err instanceof Anthropic.APIError
    const detail = err instanceof Error ? err.message : String(err)

    if (isOutage && !wasDown) {
      await postSlack(
        `:rotating_light: *AI OUTAGE* — the Anthropic API is rejecting calls, so ALL AI is down ` +
          `(SMS auto-response, drafts, scoring, summaries, voice). Patients are being held for staff ` +
          `with a holding message only. Check the Anthropic account (billing caps / credits / key).\n` +
          `Probe error: ${detail.slice(0, 300)}`
      )
    }

    return {
      status: 'failed',
      error: isOutage ? `AI outage: ${detail}` : `probe error (not alerted): ${detail}`,
      data: { healthy: false, outage: isOutage, alerted: isOutage && !wasDown },
    }
  }

  // Healthy. If we were down, announce recovery so staff know AI is back.
  if (wasDown) {
    await postSlack(':white_check_mark: *AI recovered* — the Anthropic API is responding again. Autopilot is back online.')
  }

  return { status: 'ok', items: 1, data: { healthy: true, recovered: wasDown } }
})

// Vercel Cron issues GET; keep POST as the canonical handler and alias GET to it,
// matching the other crons in this app (a prior incident had POST-only cron routes
// that Vercel's GET scheduler never actually invoked).
export const GET = POST
