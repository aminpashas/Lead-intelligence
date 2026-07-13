/**
 * New-Lead Staff Alerts
 *
 * Internal (staff-facing) notification when a brand-new lead is created:
 *   • Email  — to a fixed staff recipient list, for EVERY new lead.
 *   • Slack  — a "New Lead" card routed to a channel by the lead's service
 *              line (full-arch/implant leads → the full-arch channel, TMJ
 *              leads → the TMJ channel, …).
 *
 * This is deliberately NOT part of the ad-connector dispatcher (Google Ads /
 * Meta CAPI / GA4). Those forward *conversions* to ad platforms and, on the
 * DGS bridge path, are owned by Dion Growth Studio — routing staff alerts
 * through them would risk double-firing conversions and hit the one-row-per-org
 * limit on `connector_configs`. Staff alerts are a separate, self-contained
 * concern, so they live here and read their config from env vars.
 *
 * Configuration (Vercel env — secrets never live in code or the DB by hand):
 *   NEW_LEAD_ALERT_EMAILS   Comma-separated staff recipients. Defaults to the
 *                           SF Dentistry ops list when unset.
 *   NEW_LEAD_SLACK_ROUTES   JSON mapping a service-line key → a Slack target,
 *                           where each target is EITHER:
 *                             • a channel ID  ("C0B4LJXQZ4Z")  — posted via the
 *                               Slack Web API using SLACK_BOT_TOKEN, or
 *                             • an Incoming Webhook URL ("https://hooks.slack.com/…")
 *                           e.g. {"implants":"C0B4LJXQZ4Z","tmj":"C0B4LJUCFLZ"}
 *                           The optional "default" key catches leads whose
 *                           service line has no dedicated channel. Absent/blank
 *                           → Slack alerts are skipped (email still sends).
 *   SLACK_BOT_TOKEN         Bot token (xoxb-…) used when a route is a channel
 *                           ID. The bot must be a member of each target channel.
 *                           Unused when routes are webhook URLs.
 *
 * Everything here is best-effort: a failure in one channel never throws and
 * never blocks lead ingestion (callers invoke it inside `after()`).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Lead } from '@/types/database'
import { sendEmail } from '@/lib/messaging/resend'
import { classifyLeadServiceLines, SERVICE_LINES } from '@/lib/leads/service-line'
import { logger } from '@/lib/logger'

/** Fallback staff recipients when NEW_LEAD_ALERT_EMAILS is unset. */
const DEFAULT_ALERT_EMAILS = ['asamadian@dionhealth.com', 'hhawes@dionhealth.com']

/** Slack channel-ID shape: public 'C…', private 'G…'/'C…', DMs excluded. */
const SLACK_CHANNEL_ID_RE = /^[CG][A-Z0-9]{6,}$/
/** Slack Incoming Webhook URL shape. */
const SLACK_WEBHOOK_RE = /^https:\/\/hooks\.slack\.com\//

/** Human labels for service-line keys, for the email/Slack copy. */
const SERVICE_LABEL: Record<string, string> = Object.fromEntries(
  SERVICE_LINES.map((s) => [s.key, s.label]),
)

/** Minimal shape the alert needs — a subset of a decrypted lead row. */
export type NewLeadAlertInput = {
  id: string
  firstName: string
  lastName?: string | null
  email?: string | null
  phone?: string | null
  source?: string | null
  /** Fields consulted by classifyLeadServiceLines (all optional). */
  custom_fields?: Record<string, unknown> | null
  tags?: string[] | null
  utm_source?: string | null
  utm_campaign?: string | null
  campaign_attribution?: { campaign_name?: string | null } | null
}

/** A resolved Slack destination — either a bot-token channel or a webhook. */
type SlackTarget =
  | { kind: 'channel'; id: string }
  | { kind: 'webhook'; url: string }

/**
 * Parse NEW_LEAD_ALERT_EMAILS → a de-duplicated, trimmed recipient list.
 * Falls back to DEFAULT_ALERT_EMAILS when the env var is unset/blank.
 */
export function parseAlertRecipients(raw = process.env.NEW_LEAD_ALERT_EMAILS): string[] {
  const list = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.includes('@'))
  const chosen = list.length > 0 ? list : DEFAULT_ALERT_EMAILS
  return Array.from(new Set(chosen.map((e) => e.toLowerCase())))
}

/**
 * Parse NEW_LEAD_SLACK_ROUTES → a { serviceLineKey → target } map. A target is
 * kept only when it's a recognizable Slack channel ID or Incoming Webhook URL —
 * a defensive filter so a typo can't turn into a POST to an arbitrary host.
 * Invalid JSON or a non-object yields an empty map (Slack silently skipped).
 */
export function parseSlackRoutes(raw = process.env.NEW_LEAD_SLACK_ROUTES): Record<string, string> {
  if (!raw || !raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    logger.warn('NEW_LEAD_SLACK_ROUTES is not valid JSON — Slack alerts disabled')
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string' && (SLACK_WEBHOOK_RE.test(value) || SLACK_CHANNEL_ID_RE.test(value))) {
      out[key] = value
    }
  }
  return out
}

/** Classify a route value into a Slack target (channel ID vs webhook URL). */
function toSlackTarget(value: string): SlackTarget | null {
  if (SLACK_CHANNEL_ID_RE.test(value)) return { kind: 'channel', id: value }
  if (SLACK_WEBHOOK_RE.test(value)) return { kind: 'webhook', url: value }
  return null
}

/**
 * Which Slack targets should receive this lead, given the parsed routes. A lead
 * is routed to every configured target whose service-line key it matches; if it
 * matches none, the optional "default" route catches it. De-duplicated by the
 * raw route value so two service lines pointing at the same channel post once.
 */
export function resolveSlackTargets(
  serviceLines: string[],
  routes: Record<string, string>,
): string[] {
  const values = new Set<string>()
  for (const line of serviceLines) {
    const v = routes[line]
    if (v) values.add(v)
  }
  if (values.size === 0 && routes.default) values.add(routes.default)
  return Array.from(values)
}

/** Build the Slack Block Kit blocks (+ notification fallback text) for a lead. */
function buildSlackMessage(
  input: NewLeadAlertInput,
  serviceLines: string[],
): { blocks: Record<string, unknown>[]; text: string } {
  const name = `${input.firstName} ${input.lastName ?? ''}`.trim() || 'Unknown'
  const treatments =
    serviceLines.map((k) => SERVICE_LABEL[k] ?? k).join(', ') || 'Unspecified'
  const contact = [input.phone, input.email].filter(Boolean).join('  ·  ') || 'No contact info'

  return {
    text: `🆕 New Lead: ${name} (${treatments})`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '🆕 New Lead', emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Name:*\n${name}` },
          { type: 'mrkdwn', text: `*Treatment:*\n${treatments}` },
          { type: 'mrkdwn', text: `*Source:*\n${input.source || 'Unknown'}` },
          { type: 'mrkdwn', text: `*Contact:*\n${contact}` },
        ],
      },
    ],
  }
}

/** Post a message to one Slack target (bot-token channel or webhook URL). */
async function postToSlack(
  target: SlackTarget,
  message: { blocks: Record<string, unknown>[]; text: string },
): Promise<void> {
  if (target.kind === 'webhook') {
    await fetch(target.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks: message.blocks, text: message.text }),
      signal: AbortSignal.timeout(5000),
    })
    return
  }
  // Channel target → Slack Web API (chat.postMessage) with the bot token.
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) {
    logger.warn('NEW_LEAD_SLACK_ROUTES has a channel ID but SLACK_BOT_TOKEN is unset', {
      channel: target.id,
    })
    return
  }
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel: target.id, blocks: message.blocks, text: message.text }),
    signal: AbortSignal.timeout(5000),
  })
  // chat.postMessage returns HTTP 200 even on logical failure (ok:false).
  const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null
  if (!body?.ok) {
    logger.error('Slack chat.postMessage failed', { channel: target.id, error: body?.error ?? 'unknown' })
  }
}

/** Build the staff email (subject + html + text) for a new-lead alert. */
function buildEmail(input: NewLeadAlertInput, serviceLines: string[]): {
  subject: string
  html: string
  text: string
} {
  const name = `${input.firstName} ${input.lastName ?? ''}`.trim() || 'Unknown'
  const treatments = serviceLines.map((k) => SERVICE_LABEL[k] ?? k).join(', ') || 'Unspecified'
  const rows: [string, string][] = [
    ['Name', name],
    ['Treatment', treatments],
    ['Phone', input.phone || '—'],
    ['Email', input.email || '—'],
    ['Source', input.source || 'Unknown'],
  ]
  const subject = `🆕 New lead: ${name} (${treatments})`
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px">
      <h2 style="margin:0 0 12px">🆕 New Lead</h2>
      <table style="border-collapse:collapse;width:100%">
        ${rows
          .map(
            ([k, v]) =>
              `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;white-space:nowrap">${k}</td><td style="padding:6px 0;font-weight:600">${escapeHtml(v)}</td></tr>`,
          )
          .join('')}
      </table>
    </div>`.trim()
  const text = `New Lead\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}`
  return { subject, html, text }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Fire staff alerts for a newly-created lead. Best-effort on every channel —
 * an email failure never blocks Slack and vice-versa, and nothing throws.
 *
 * `input` carries only the fields the alert needs; PII (name/email/phone) must
 * already be DECRYPTED by the caller (both ingest paths hold the plaintext at
 * insert time). The `supabase` handle is accepted for future audit logging and
 * to keep the signature stable across ingest paths.
 */
export async function notifyNewLead(
  _supabase: SupabaseClient,
  params: { lead: NewLeadAlertInput; organizationId: string },
): Promise<void> {
  const { lead } = params

  // Classify service line(s) from the same signals the pipeline/leads filters
  // use, so Slack routing agrees with the rest of the app.
  const serviceLines = classifyLeadServiceLines({
    custom_fields: lead.custom_fields ?? {},
    tags: lead.tags ?? [],
    utm_source: lead.utm_source ?? null,
    utm_campaign: lead.utm_campaign ?? null,
    campaign_attribution: lead.campaign_attribution ?? null,
  } as Lead)

  // ── Email (every new lead) ───────────────────────────────────────────
  try {
    const recipients = parseAlertRecipients()
    const { subject, html, text } = buildEmail(lead, serviceLines)
    // One send per recipient: the wrapper's test-allowlist/dry-run clamps and
    // Resend both key on a single `to`, and looping keeps a blocked recipient
    // from suppressing the others.
    await Promise.allSettled(
      recipients.map((to) => sendEmail({ to, subject, html, text })),
    )
  } catch (err) {
    logger.error('new-lead alert email failed', {
      lead_id: lead.id,
      error: err instanceof Error ? err.message : 'unknown',
    })
  }

  // ── Slack (service-line-routed) ──────────────────────────────────────
  try {
    const routes = parseSlackRoutes()
    const targets = resolveSlackTargets(serviceLines, routes)
      .map(toSlackTarget)
      .filter((t): t is SlackTarget => t !== null)
    if (targets.length > 0) {
      const message = buildSlackMessage(lead, serviceLines)
      await Promise.allSettled(targets.map((t) => postToSlack(t, message)))
    }
  } catch (err) {
    logger.error('new-lead alert Slack failed', {
      lead_id: lead.id,
      error: err instanceof Error ? err.message : 'unknown',
    })
  }
}
