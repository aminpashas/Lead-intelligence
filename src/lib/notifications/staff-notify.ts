/**
 * Multi-channel staff notifications (Workstream D5)
 *
 * One front door for "a human needs to see this conversation": inbound
 * patient messages on hold/human-owned paths, human-task pings, and AI
 * escalations all route through here.
 *
 * Channels: Slack (org-level, via the connector dispatcher scoped to
 * only:['slack']), Web Push, and staff SMS. Per-user channel toggles live in
 * user_profiles.notification_prefs (default ALL ON — an explicit `false`
 * opts out). Slack additionally requires the org's Slack connector to list
 * 'message.received' in its subscribed events (explicit opt-in).
 *
 * Recipient chain (assignee-first): leads.assigned_to when active → active
 * users holding a requested role (when the caller passes one) → org admins
 * (cap 5) as the final fallback — all via resolveAssignee
 * (src/lib/automation/tasks.ts).
 *
 * Noise controls:
 *   - PRESENCE SUPPRESSION: recipients actively viewing the conversation
 *     (conversation_viewers heartbeat within 75s) are dropped — they're
 *     already looking at it.
 *   - COOLDOWN DEDUPE: a (conversation, user, channel) that was notified in
 *     the last 10 minutes is skipped UNLESS the user has viewed the
 *     conversation since that notification (a burst of texts → one ping;
 *     but once you've looked, the next message pings again).
 *
 * Every send is appended to notification_log (user_id NULL for org-level
 * Slack). Everything fails soft — this module must NEVER throw into a
 * webhook or automation path.
 *
 * USAGE — call on the hold/human paths after an inbound message lands
 * (Twilio SMS webhook, email-reply route — wiring owned by the D1/D3 work):
 *
 *   import { notifyInboundMessage } from '@/lib/notifications/staff-notify'
 *   notifyInboundMessage(serviceSupabase, {
 *     organizationId, conversationId, leadId,
 *     messagePreview: inboundBody.slice(0, 200),
 *   }).catch(() => {})
 *
 * Pass a SERVICE-ROLE client: push_subscriptions RLS is user-owns-row and
 * notification_log writes are service-role only.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveAssignee } from '@/lib/automation/tasks'
import { getActiveViewers, PRESENCE_WINDOW_SECONDS } from '@/lib/automation/presence'
import { dispatchConnectorEvent } from '@/lib/connectors/dispatcher'
import { buildConnectorLeadData } from '@/lib/connectors/helpers'
import { sendSMS } from '@/lib/messaging/twilio'
import { sendPushToUser } from '@/lib/notifications/web-push'
import { decryptField } from '@/lib/encryption'
import { logger } from '@/lib/logger'

/** Per-(conversation, user, channel) re-notify cooldown. */
export const NOTIFY_COOLDOWN_MS = 10 * 60 * 1000

/** Max characters of message content forwarded to any channel. */
export const PREVIEW_MAX_CHARS = 120

export type NotifyChannel = 'slack' | 'push' | 'sms'

export type NotificationPrefs = {
  sms?: boolean
  email?: boolean
  push?: boolean
}

export type StaffRecipient = {
  id: string
  full_name: string | null
  phone: string | null
  email: string | null
  notification_prefs: NotificationPrefs | null
}

export type NotifyInboundMessageInput = {
  organizationId: string
  conversationId: string
  leadId: string
  /** Short excerpt of the inbound message (clamped to 120 chars everywhere). */
  messagePreview: string
  /** 'inbound' (default) = patient message; 'task' = human-task/escalation ping. */
  kind?: 'inbound' | 'task'
  /** human_tasks.id when kind === 'task'. */
  taskId?: string
  /**
   * Restrict which channels fire. Default: all of slack/push/sms.
   * (escalation.ts keeps its own bespoke copy and calls sendPushToUser /
   * logStaffNotification directly rather than routing through here.)
   */
  channels?: NotifyChannel[]
}

export type NotifyResult = {
  /** Per-user channel sends that actually went out. */
  sent: Array<{ userId: string; channel: NotifyChannel }>
  /** True when the org-level Slack dispatch was attempted this call. */
  slackDispatched: boolean
  /** Recipients dropped because they were actively viewing the thread. */
  suppressedViewing: string[]
}

const EMPTY_RESULT: NotifyResult = { sent: [], slackDispatched: false, suppressedViewing: [] }

/** Decrypt-if-needed with plaintext fallback (matches escalation.ts posture). */
function decryptSafe(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    return decryptField(value) || value
  } catch {
    return value
  }
}

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'https://app.example.com'
}

function clampPreview(text: string): string {
  const clean = (text || '').replace(/\s+/g, ' ').trim()
  return clean.length > PREVIEW_MAX_CHARS ? `${clean.slice(0, PREVIEW_MAX_CHARS - 1)}…` : clean
}

/**
 * Resolve who should be pinged about a lead's conversation, assignee-first:
 *   1. leads.assigned_to (when still an active user in the org)
 *   2. active users holding `assignedRole`, when a role is requested
 *   3. org admins (cap 5)
 * Returns full profile rows (name/phone/email/prefs) for the chosen users.
 */
export async function resolveStaffRecipients(
  supabase: SupabaseClient,
  organizationId: string,
  leadId?: string | null,
  assignedRole?: string | null
): Promise<StaffRecipient[]> {
  try {
    const resolved = await resolveAssignee(supabase, organizationId, leadId, assignedRole)
    const ids = (resolved.userId ? [resolved.userId] : resolved.pool).slice(0, 5)
    if (ids.length === 0) return []

    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('id, full_name, phone, email, notification_prefs, is_active')
      .eq('organization_id', organizationId)
      .in('id', ids)

    return ((profiles as Array<StaffRecipient & { is_active: boolean }>) ?? [])
      .filter((p) => p.is_active !== false)
      .map(({ id, full_name, phone, email, notification_prefs }) => ({
        id,
        full_name,
        phone,
        email,
        notification_prefs,
      }))
  } catch (err) {
    logger.warn('StaffNotify: resolveStaffRecipients failed', {
      organizationId,
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

type LogRow = { user_id: string | null; channel: string; sent_at: string }
type ViewerRow = { user_id: string; last_seen_at: string }

/**
 * Notify staff that an inbound message (or human task) on a conversation
 * needs attention. See module docs for recipient chain, suppression, and
 * dedupe semantics. Never throws.
 */
export async function notifyInboundMessage(
  supabase: SupabaseClient,
  input: NotifyInboundMessageInput
): Promise<NotifyResult> {
  try {
    const channels = input.channels ?? ['slack', 'push', 'sms']
    const kind = input.kind ?? 'inbound'
    const eventType = kind === 'task' ? 'task.assigned' : 'message.received'
    const preview = clampPreview(input.messagePreview)
    const conversationUrl = `${appUrl()}/conversations/${input.conversationId}`
    const now = Date.now()

    // ── Recipients (assignee-first, admin fallback) ─────────────────
    const recipients = await resolveStaffRecipients(
      supabase,
      input.organizationId,
      input.leadId
    )

    // ── Presence + cooldown state (one read each) ───────────────────
    const activeViewers = await getActiveViewers(supabase, input.conversationId)
    const viewing = new Set(activeViewers.map((v) => v.user_id))

    let recentLogs: LogRow[] = []
    let viewerRows: ViewerRow[] = []
    try {
      const cutoff = new Date(now - NOTIFY_COOLDOWN_MS).toISOString()
      const [{ data: logs }, { data: viewers }] = await Promise.all([
        supabase
          .from('notification_log')
          .select('user_id, channel, sent_at')
          .eq('organization_id', input.organizationId)
          .eq('conversation_id', input.conversationId)
          .gte('sent_at', cutoff),
        supabase
          .from('conversation_viewers')
          .select('user_id, last_seen_at')
          .eq('conversation_id', input.conversationId),
      ])
      recentLogs = (logs as LogRow[]) ?? []
      viewerRows = (viewers as ViewerRow[]) ?? []
    } catch {
      // Dedupe state unavailable → default to sending (better twice than never).
    }

    const lastSeenByUser = new Map(viewerRows.map((v) => [v.user_id, new Date(v.last_seen_at).getTime()]))

    /** Cooldown: skip when a recent send exists AND the user (null = org-level
     *  Slack) hasn't viewed the conversation since that send. */
    const inCooldown = (userId: string | null, channel: NotifyChannel): boolean => {
      let latest = 0
      for (const row of recentLogs) {
        if (row.user_id === userId && row.channel === channel) {
          const t = new Date(row.sent_at).getTime()
          if (t > latest) latest = t
        }
      }
      if (!latest) return false
      if (userId) {
        const seen = lastSeenByUser.get(userId) ?? 0
        if (seen > latest) return false // viewed since last ping → ping again
      }
      return true
    }

    // Presence suppression (per-user channels only — Slack is a shared channel).
    const suppressedViewing = recipients.filter((r) => viewing.has(r.id)).map((r) => r.id)
    const targets = recipients.filter((r) => !viewing.has(r.id))

    const logRows: Array<Record<string, unknown>> = []
    const logSend = (userId: string | null, channel: NotifyChannel) => {
      logRows.push({
        organization_id: input.organizationId,
        conversation_id: input.conversationId,
        lead_id: input.leadId,
        user_id: userId,
        channel,
        event_type: eventType,
      })
    }

    // ── Lead context (name for copy; full row for the Slack event) ──
    let leadRow: Record<string, unknown> | null = null
    try {
      const { data } = await supabase
        .from('leads')
        .select('*')
        .eq('id', input.leadId)
        .eq('organization_id', input.organizationId)
        .maybeSingle()
      leadRow = (data as Record<string, unknown>) ?? null
    } catch {
      leadRow = null
    }
    const leadName = leadRow
      ? `${decryptSafe(leadRow.first_name as string) || ''} ${decryptSafe(leadRow.last_name as string) || ''}`.trim() || 'Unknown patient'
      : 'Unknown patient'

    const result: NotifyResult = { sent: [], slackDispatched: false, suppressedViewing }

    // ── Slack (org-level; once per conversation-burst, not per recipient) ──
    if (channels.includes('slack') && leadRow && !inCooldown(null, 'slack')) {
      try {
        const leadData = buildConnectorLeadData(leadRow)
        // The Slack card shows the lead's display name — decrypt like
        // escalation.ts does (buildConnectorLeadData passes names through raw).
        leadData.firstName = decryptSafe(leadRow.first_name as string) || leadData.firstName
        leadData.lastName = decryptSafe(leadRow.last_name as string) || leadData.lastName

        const assignee = recipients[0]
        await dispatchConnectorEvent(
          supabase,
          {
            type: 'message.received',
            organizationId: input.organizationId,
            leadId: input.leadId,
            timestamp: new Date(now).toISOString(),
            data: {
              lead: leadData,
              metadata: {
                conversation_id: input.conversationId,
                conversation_url: conversationUrl,
                message_preview: preview,
                assignee_name: assignee?.full_name || null,
                kind,
                task_id: input.taskId ?? null,
              },
            },
          },
          { only: ['slack'] } // ad platforms must never see message.received
        )
        result.slackDispatched = true
        logSend(null, 'slack')
      } catch (err) {
        logger.warn('StaffNotify: slack dispatch failed', {
          conversationId: input.conversationId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // ── Per-user channels ───────────────────────────────────────────
    const title =
      kind === 'task' ? `Task: ${leadName} needs attention` : `New message from ${leadName}`

    for (const recipient of targets) {
      const prefs = recipient.notification_prefs || {}

      // Web push (default on)
      if (channels.includes('push') && prefs.push !== false && !inCooldown(recipient.id, 'push')) {
        try {
          const delivered = await sendPushToUser(supabase, recipient.id, {
            title,
            body: preview,
            url: `/conversations/${input.conversationId}`,
            tag: `conversation-${input.conversationId}`,
          })
          if (delivered > 0) {
            result.sent.push({ userId: recipient.id, channel: 'push' })
            logSend(recipient.id, 'push')
          }
        } catch {
          // web-push already fails soft; belt-and-braces
        }
      }

      // Staff SMS (default on)
      if (channels.includes('sms') && prefs.sms !== false && !inCooldown(recipient.id, 'sms')) {
        const phone = decryptSafe(recipient.phone)
        if (phone) {
          try {
            await sendSMS(
              phone,
              `💬 ${title}: "${preview}" — reply: ${conversationUrl}`
            )
            result.sent.push({ userId: recipient.id, channel: 'sms' })
            logSend(recipient.id, 'sms')
          } catch {
            // Non-critical — continue to the next recipient
          }
        }
      }
    }

    // ── Ledger (single batched insert; service-role only per RLS) ──
    if (logRows.length > 0) {
      try {
        await supabase.from('notification_log').insert(logRows)
      } catch {
        // Ledger failure must not fail the notification path.
      }
    }

    return result
  } catch (err) {
    logger.warn('StaffNotify: notifyInboundMessage failed', {
      conversationId: input.conversationId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { ...EMPTY_RESULT }
  }
}

export type NotifyHumanTaskInput = {
  organizationId: string
  leadId: string
  /** Copy for the ping title (e.g. "First touch: Jane"). */
  title: string
  /** Short body, clamped to 120 chars. */
  preview: string
  /** human_tasks.id, for the ledger event + push tag. */
  taskId?: string
  /** Role queue the task routes to when no specific user owns the lead. */
  assignedRole?: string | null
  /** Restrict channels. Default push + sms — org Slack is the new-lead alert's job. */
  channels?: Array<'push' | 'sms'>
}

/**
 * Ping staff about a human task that has NO conversation yet — the first_touch
 * case, where the lead hasn't been messaged so there is nothing to key presence
 * or a /conversations link on. Lead-keyed sibling of notifyInboundMessage:
 * assignee-first recipients (lead owner → role queue → admins), push + sms only,
 * and a lead-scoped cooldown (one task ping per lead/user/channel per
 * NOTIFY_COOLDOWN_MS). Deep-links to the lead. Never throws.
 */
export async function notifyHumanTask(
  supabase: SupabaseClient,
  input: NotifyHumanTaskInput
): Promise<NotifyResult> {
  try {
    const channels = input.channels ?? ['push', 'sms']
    const preview = clampPreview(input.preview)
    const leadUrl = `${appUrl()}/leads/${input.leadId}`
    const now = Date.now()

    const recipients = await resolveStaffRecipients(
      supabase,
      input.organizationId,
      input.leadId,
      input.assignedRole ?? null
    )
    if (recipients.length === 0) return { ...EMPTY_RESULT }

    // Lead-scoped cooldown: skip a (lead, user, channel) already pinged for a
    // task in the last window. No conversation exists, so there is no presence
    // to suppress on — the cooldown is the only noise control here.
    let recentLogs: LogRow[] = []
    try {
      const cutoff = new Date(now - NOTIFY_COOLDOWN_MS).toISOString()
      const { data: logs } = await supabase
        .from('notification_log')
        .select('user_id, channel, sent_at')
        .eq('organization_id', input.organizationId)
        .eq('lead_id', input.leadId)
        .eq('event_type', 'task.assigned')
        .gte('sent_at', cutoff)
      recentLogs = (logs as LogRow[]) ?? []
    } catch {
      // Dedupe state unavailable → default to sending (better twice than never).
    }
    const inCooldown = (userId: string, channel: NotifyChannel): boolean =>
      recentLogs.some((r) => r.user_id === userId && r.channel === channel)

    const logRows: Array<Record<string, unknown>> = []
    const logSend = (userId: string, channel: NotifyChannel) => {
      logRows.push({
        organization_id: input.organizationId,
        lead_id: input.leadId,
        user_id: userId,
        channel,
        event_type: 'task.assigned',
      })
    }

    const result: NotifyResult = { sent: [], slackDispatched: false, suppressedViewing: [] }
    const title = `Task: ${input.title}`

    for (const recipient of recipients) {
      const prefs = recipient.notification_prefs || {}

      if (channels.includes('push') && prefs.push !== false && !inCooldown(recipient.id, 'push')) {
        try {
          const delivered = await sendPushToUser(supabase, recipient.id, {
            title,
            body: preview,
            url: `/leads/${input.leadId}`,
            tag: `task-${input.taskId ?? input.leadId}`,
          })
          if (delivered > 0) {
            result.sent.push({ userId: recipient.id, channel: 'push' })
            logSend(recipient.id, 'push')
          }
        } catch {
          // web-push already fails soft; belt-and-braces
        }
      }

      if (channels.includes('sms') && prefs.sms !== false && !inCooldown(recipient.id, 'sms')) {
        const phone = decryptSafe(recipient.phone)
        if (phone) {
          try {
            await sendSMS(phone, `📋 ${title}: "${preview}" — ${leadUrl}`)
            result.sent.push({ userId: recipient.id, channel: 'sms' })
            logSend(recipient.id, 'sms')
          } catch {
            // Non-critical — continue to the next recipient
          }
        }
      }
    }

    if (logRows.length > 0) {
      try {
        await supabase.from('notification_log').insert(logRows)
      } catch {
        // Ledger failure must not fail the notification path.
      }
    }

    return result
  } catch (err) {
    logger.warn('StaffNotify: notifyHumanTask failed', {
      leadId: input.leadId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { ...EMPTY_RESULT }
  }
}

/**
 * Log a staff notification sent OUTSIDE this module (escalation.ts keeps its
 * bespoke SMS/email copy but still writes to the shared ledger so cooldowns
 * and audits see every channel).
 */
export async function logStaffNotification(
  supabase: SupabaseClient,
  row: {
    organizationId: string
    conversationId?: string | null
    leadId?: string | null
    userId?: string | null
    channel: 'slack' | 'sms' | 'email' | 'push'
    eventType: string
  }
): Promise<void> {
  try {
    await supabase.from('notification_log').insert({
      organization_id: row.organizationId,
      conversation_id: row.conversationId ?? null,
      lead_id: row.leadId ?? null,
      user_id: row.userId ?? null,
      channel: row.channel,
      event_type: row.eventType,
    })
  } catch {
    // Ledger failure is non-critical.
  }
}

// Re-export so callers (and the presence window) stay in sync with D4.
export { PRESENCE_WINDOW_SECONDS }
