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
import { sendEmail, transactionalFrom } from '@/lib/messaging/resend'
import { classifyLeadServiceLines, SERVICE_LINES } from '@/lib/leads/service-line'
import { displaySourceLabel } from '@/lib/attribution'
import { classifyChannelFromUtm } from '@/lib/attribution/classify-channel'
import { getPublicAppUrl } from '@/lib/app-url'
import { zonedDateTimeLabel, DEFAULT_PRACTICE_TIMEZONE } from '@/lib/time/zoned'
import { logger } from '@/lib/logger'

/** Fallback staff recipients when NEW_LEAD_ALERT_EMAILS is unset. */
const DEFAULT_ALERT_EMAILS = ['asamadian@dionhealth.com', 'hhawes@dionhealth.com']

/**
 * Replay/backfill guard. A "New Lead" alert is only meaningful for a genuinely
 * fresh submission — when a bridge REPLAYS its history (e.g. the 2026-07-13 DGS
 * push that re-ingested all 54,699 inbound leads), each first-time insert would
 * otherwise blast a staff alert for a lead that's weeks or months old. When the
 * caller supplies the source's original submission time and it's older than this
 * window, the alert is suppressed (the lead is still ingested normally).
 *
 * Real-time paths (public form webhook) pass no timestamp → never suppressed.
 */
const DEFAULT_ALERT_MAX_AGE_HOURS = 48

/**
 * True when `sourceCreatedAt` is a valid timestamp older than `maxAgeHours` — i.e.
 * this is a backfilled/replayed lead that should NOT trigger a fresh-lead alert.
 * Unparseable/absent timestamps return false (fail-open: alert as normal).
 */
export function isStaleForAlert(
  sourceCreatedAt: string | null | undefined,
  now: Date = new Date(),
  maxAgeHours: number = Number(process.env.NEW_LEAD_ALERT_MAX_AGE_HOURS) || DEFAULT_ALERT_MAX_AGE_HOURS,
): boolean {
  if (!sourceCreatedAt) return false
  const t = Date.parse(sourceCreatedAt)
  if (Number.isNaN(t)) return false
  const ageMs = now.getTime() - t
  return ageMs > maxAgeHours * 3_600_000
}

/** Slack channel-ID shape: public 'C…', private 'G…'/'C…', DMs excluded. */
const SLACK_CHANNEL_ID_RE = /^[CG][A-Z0-9]{6,}$/
/** Slack Incoming Webhook URL shape. */
const SLACK_WEBHOOK_RE = /^https:\/\/hooks\.slack\.com\//

/** Human labels for service-line keys, for the email/Slack copy. */
const SERVICE_LABEL: Record<string, string> = Object.fromEntries(
  SERVICE_LINES.map((s) => [s.key, s.label]),
)

/**
 * Shape the alert needs — a subset of a decrypted lead row. Callers pass only
 * the fields they hold in plaintext at ingest time; every enrichment field is
 * optional, so the real-time form path and the bulk DGS bridge can each
 * contribute whatever they know and the builders render only what's present.
 */
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
  utm_medium?: string | null
  utm_campaign?: string | null
  campaign_attribution?: { campaign_name?: string | null; channel?: string | null } | null
  /** Landing-page URL — niche service-line signal for GMB/organic leads. */
  landing_page_url?: string | null

  // ── Optional enrichment (rendered only when supplied) ────────────────
  /** The lead's own words (form message / bridged notes). */
  message?: string | null
  city?: string | null
  state?: string | null
  /** AI qualification bucket — 'hot' | 'warm' | 'cold' | 'unqualified'. */
  aiQualification?: string | null
  /** AI score 0–100. */
  aiScore?: number | null
  /** One-line AI summary of the lead. */
  aiSummary?: string | null
  /** Financial pre-qual tier — 'tier_a' … 'tier_d'. */
  financialTier?: string | null
  /** Financing readiness 0–100. */
  financingReadiness?: number | null
  /** Self-reported preferred monthly payment budget, in dollars. */
  monthlyBudget?: number | null
  /** Original submission time (ISO) — rendered in the practice timezone. */
  submittedAt?: string | null
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

/** Visual treatment for each AI qualification bucket. */
const QUAL_META: Record<string, { emoji: string; color: string; label: string }> = {
  hot: { emoji: '🔥', color: '#dc2626', label: 'Hot' },
  warm: { emoji: '🌤️', color: '#d97706', label: 'Warm' },
  cold: { emoji: '❄️', color: '#2563eb', label: 'Cold' },
  unqualified: { emoji: '🚫', color: '#6b7280', label: 'Unqualified' },
}

/** Human labels for financial pre-qual tiers. */
const TIER_LABEL: Record<string, string> = {
  tier_a: 'Tier A — strong',
  tier_b: 'Tier B — good',
  tier_c: 'Tier C — fair',
  tier_d: 'Tier D — limited',
}

/** Format a dollar monthly-budget, or null when absent/invalid. */
function formatMonthlyBudget(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null
  return `$${Math.round(n).toLocaleString('en-US')}/mo`
}

/** Format an ISO timestamp in the practice timezone, or null when unparseable. */
function formatSubmittedAt(iso: string | null | undefined): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return zonedDateTimeLabel(new Date(t), DEFAULT_PRACTICE_TIMEZONE)
}

/**
 * The normalized, render-ready content shared by the email and Slack builders.
 * `shortRows`, `aiSummary`, and `message` are already emptiness-filtered, so
 * each builder just lays out whatever survived.
 */
type AlertContent = {
  name: string
  treatments: string
  qual: { emoji: string; color: string; label: string; score: number | null } | null
  /** Short [label, value] pairs safe to show as compact two-column fields. */
  shortRows: [string, string][]
  aiSummary: string | null
  message: string | null
  leadUrl: string | null
}

/** Distil an alert input into the render-ready content both channels share. */
function collectAlertContent(input: NewLeadAlertInput, serviceLines: string[]): AlertContent {
  const name = `${input.firstName} ${input.lastName ?? ''}`.trim() || 'Unknown'
  const treatments = serviceLines.map((k) => SERVICE_LABEL[k] ?? k).join(', ') || 'Unspecified'

  const qualKey = (input.aiQualification ?? '').toLowerCase()
  const qualMeta = QUAL_META[qualKey]
  const qual = qualMeta
    ? { ...qualMeta, score: typeof input.aiScore === 'number' ? input.aiScore : null }
    : null

  const campaign = input.campaign_attribution?.campaign_name || input.utm_campaign || null
  const utm = [input.utm_source, input.utm_medium].filter(Boolean).join(' / ') || null

  // Show where the lead actually came from, never the aggregator/call-tracking
  // tool ("whatconverts", …). Prefer the DGS-resolved attribution channel; fall
  // back to a channel derived from the flat UTM fields so the alert resolves a
  // real source even when the caller didn't pre-resolve one.
  const resolvedChannel =
    input.campaign_attribution?.channel ??
    classifyChannelFromUtm({
      utm_source: input.utm_source,
      utm_medium: input.utm_medium,
      utm_campaign: input.utm_campaign,
    })?.channel ??
    null
  const source = displaySourceLabel(input.source, resolvedChannel)
  const location = [input.city, input.state].filter(Boolean).join(', ') || null
  const financing =
    [
      input.financialTier ? (TIER_LABEL[input.financialTier] ?? input.financialTier) : null,
      formatMonthlyBudget(input.monthlyBudget),
      typeof input.financingReadiness === 'number' && input.financingReadiness > 0
        ? `${input.financingReadiness}/100 ready`
        : null,
    ]
      .filter(Boolean)
      .join('  ·  ') || null

  const shortRows: [string, string][] = (
    [
      ['Phone', input.phone],
      ['Email', input.email],
      ['Campaign', campaign],
      ['Source', source],
      ['UTM', utm],
      ['Location', location],
      ['Financing', financing],
      ['Submitted', formatSubmittedAt(input.submittedAt)],
    ] as [string, string | null | undefined][]
  )
    .map(([k, v]) => [k, (v ?? '').toString().trim()] as [string, string])
    .filter(([, v]) => v !== '')

  const leadUrl = input.id ? `${getPublicAppUrl()}/leads/${input.id}` : null

  return {
    name,
    treatments,
    qual,
    shortRows,
    aiSummary: input.aiSummary?.trim() || null,
    message: input.message?.trim() || null,
    leadUrl,
  }
}

/** Chunk an array into sub-arrays of at most `size` (Slack caps fields at 10). */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Build the Slack Block Kit blocks (+ notification fallback text) for a lead. */
function buildSlackMessage(
  input: NewLeadAlertInput,
  serviceLines: string[],
): { blocks: Record<string, unknown>[]; text: string } {
  const c = collectAlertContent(input, serviceLines)
  const headline = c.qual
    ? `${c.qual.emoji} New ${c.qual.label} Lead${c.qual.score != null ? ` · ${c.qual.score}/100` : ''}`
    : '🆕 New Lead'

  const fieldPairs: [string, string][] = [
    ['Name', c.name],
    ['Treatment', c.treatments],
    ...c.shortRows,
  ]

  const blocks: Record<string, unknown>[] = [
    { type: 'header', text: { type: 'plain_text', text: headline, emoji: true } },
  ]
  // Slack allows at most 10 fields per section — chunk so nothing is dropped.
  for (const group of chunk(fieldPairs, 10)) {
    blocks.push({
      type: 'section',
      fields: group.map(([k, v]) => ({ type: 'mrkdwn', text: `*${k}:*\n${v}` })),
    })
  }
  if (c.aiSummary) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*AI summary:*\n${c.aiSummary}` } })
  }
  if (c.message) {
    // Blockquote the lead's own words so they stand apart from CRM metadata.
    const quoted = c.message.split('\n').map((l) => `> ${l}`).join('\n')
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Message:*\n${quoted}` } })
  }
  if (c.leadUrl) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View lead in CRM', emoji: true },
          url: c.leadUrl,
          style: 'primary',
        },
      ],
    })
  }

  return { text: `${headline}: ${c.name} (${c.treatments})`, blocks }
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
  const c = collectAlertContent(input, serviceLines)

  // Every field as a table row, in the order staff scan them.
  const rows: [string, string][] = [
    ['Name', c.name],
    ['Treatment', c.treatments],
    ...c.shortRows,
    ...(c.aiSummary ? ([['AI summary', c.aiSummary]] as [string, string][]) : []),
  ]

  const subjectPrefix = c.qual ? `${c.qual.emoji} New ${c.qual.label} lead` : '🆕 New lead'
  const subject = `${subjectPrefix}: ${c.name} (${c.treatments})`

  const badge = c.qual
    ? `<span style="display:inline-block;padding:3px 12px;border-radius:999px;background:${c.qual.color};color:#fff;font-weight:700;font-size:13px">${c.qual.emoji} ${c.qual.label}${
        c.qual.score != null ? ` · ${c.qual.score}/100` : ''
      }</span>`
    : ''
  const messageBlock = c.message
    ? `<div style="margin:16px 0;padding:12px 14px;background:#f9fafb;border-left:3px solid #d1d5db;border-radius:4px;color:#374151;white-space:pre-wrap">${escapeHtml(
        c.message,
      )}</div>`
    : ''
  const cta = c.leadUrl
    ? `<a href="${escapeHtml(
        c.leadUrl,
      )}" style="display:inline-block;margin-top:8px;padding:10px 18px;background:#111827;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px">View lead in CRM →</a>`
    : ''

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;color:#111827">
      <div style="display:flex;align-items:center;gap:12px;margin:0 0 14px">
        <h2 style="margin:0;font-size:20px">🆕 New Lead</h2>
        ${badge}
      </div>
      <table style="border-collapse:collapse;width:100%;font-size:14px">
        ${rows
          .map(
            ([k, v]) =>
              `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:6px 0;font-weight:600">${escapeHtml(v)}</td></tr>`,
          )
          .join('')}
      </table>
      ${messageBlock}
      ${cta}
    </div>`.trim()

  const textLines = [
    subjectPrefix,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(c.message ? ['', `Message:`, c.message] : []),
    ...(c.leadUrl ? ['', `View lead: ${c.leadUrl}`] : []),
  ]
  return { subject, html, text: textLines.join('\n') }
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
  params: {
    lead: NewLeadAlertInput
    organizationId: string
    /**
     * The source's ORIGINAL submission time (e.g. DGS inbound_leads.created_at),
     * when the caller knows it. Used to suppress alerts for backfilled/replayed
     * leads. Omit for real-time ingest (public form) → always alerts.
     */
    sourceCreatedAt?: string | null
  },
): Promise<void> {
  const { lead } = params

  // Backfill/replay guard: an old submission being (re)ingested must not blast a
  // fresh-lead alert. The lead itself is already persisted; we only skip the ping.
  if (isStaleForAlert(params.sourceCreatedAt)) {
    logger.info('new-lead alert suppressed — backfilled lead older than alert window', {
      lead_id: lead.id,
      source_created_at: params.sourceCreatedAt,
    })
    return
  }

  // Classify service line(s) from the same signals the pipeline/leads filters
  // use, so Slack routing agrees with the rest of the app.
  const serviceLines = classifyLeadServiceLines({
    custom_fields: lead.custom_fields ?? {},
    tags: lead.tags ?? [],
    utm_source: lead.utm_source ?? null,
    utm_campaign: lead.utm_campaign ?? null,
    campaign_attribution: lead.campaign_attribution ?? null,
    landing_page_url: lead.landing_page_url ?? null,
  } as Lead)

  // ── Email (every new lead) ───────────────────────────────────────────
  try {
    const recipients = parseAlertRecipients()
    const { subject, html, text } = buildEmail(lead, serviceLines)
    // One send per recipient: the wrapper's test-allowlist/dry-run clamps and
    // Resend both key on a single `to`, and looping keeps a blocked recipient
    // from suppressing the others.
    await Promise.allSettled(
      recipients.map((to) => sendEmail({ to, from: transactionalFrom(), subject, html, text })),
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
