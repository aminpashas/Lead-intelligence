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
 *   NEW_LEAD_SLACK_ROUTES   JSON mapping a service-line key → Slack Incoming
 *                           Webhook URL, e.g.
 *                             {"implants":"https://hooks.slack.com/…",
 *                              "tmj":"https://hooks.slack.com/…",
 *                              "default":"https://hooks.slack.com/…"}
 *                           The optional "default" key catches leads whose
 *                           service line has no dedicated channel. Absent/blank
 *                           → Slack alerts are simply skipped (email still sends).
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
 * Parse NEW_LEAD_SLACK_ROUTES → a { serviceLineKey → webhookUrl } map.
 * Invalid JSON or a non-object yields an empty map (Slack silently skipped).
 * Only https Slack-shaped URLs are kept — a defensive filter so a typo can't
 * turn into an SSRF-ish POST to an arbitrary host.
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
    if (typeof value === 'string' && /^https:\/\/hooks\.slack\.com\//.test(value)) {
      out[key] = value
    }
  }
  return out
}

/**
 * Which Slack webhook URLs should receive this lead, given the parsed routes.
 * A lead is routed to every configured channel whose service-line key it
 * matches; if it matches none, the optional "default" route catches it. The
 * result is de-duplicated by URL so two service lines pointing at the same
 * channel only post once.
 */
export function resolveSlackTargets(
  serviceLines: string[],
  routes: Record<string, string>,
): string[] {
  const urls = new Set<string>()
  for (const line of serviceLines) {
    const url = routes[line]
    if (url) urls.add(url)
  }
  if (urls.size === 0 && routes.default) urls.add(routes.default)
  return Array.from(urls)
}

/** Build the Slack Block Kit payload for a new-lead card. */
function buildSlackPayload(input: NewLeadAlertInput, serviceLines: string[]): Record<string, unknown> {
  const name = `${input.firstName} ${input.lastName ?? ''}`.trim() || 'Unknown'
  const treatments =
    serviceLines.map((k) => SERVICE_LABEL[k] ?? k).join(', ') || 'Unspecified'
  const contact = [input.phone, input.email].filter(Boolean).join('  ·  ') || 'No contact info'

  return {
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
    if (targets.length > 0) {
      const payload = buildSlackPayload(lead, serviceLines)
      await Promise.allSettled(
        targets.map((url) =>
          fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(5000),
          }),
        ),
      )
    }
  } catch (err) {
    logger.error('new-lead alert Slack failed', {
      lead_id: lead.id,
      error: err instanceof Error ? err.message : 'unknown',
    })
  }
}
