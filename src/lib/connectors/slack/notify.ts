/**
 * Slack Notification Connector
 *
 * Sends rich, formatted notifications to Slack channels via
 * Incoming Webhooks when important CRM events occur (hot lead,
 * consultation booked, case closed, etc.)
 *
 * Uses Slack Block Kit for rich formatting.
 */

import type {
  ConnectorEvent,
  ConnectorResult,
  SlackConfig,
  ConnectorEventType,
} from '../types'

// Emoji + title for each event type
const EVENT_DISPLAY: Record<ConnectorEventType, { emoji: string; title: string; color: string }> = {
  'lead.created': { emoji: '🆕', title: 'New Lead', color: '#3b82f6' },
  'lead.qualified': { emoji: '🔥', title: 'Lead Qualified', color: '#f97316' },
  'lead.scored': { emoji: '🧠', title: 'Lead Scored', color: '#8b5cf6' },
  'stage.changed': { emoji: '📊', title: 'Stage Changed', color: '#6b7280' },
  'consultation.scheduled': { emoji: '📅', title: 'Consultation Booked', color: '#10b981' },
  'consultation.completed': { emoji: '✅', title: 'Consultation Completed', color: '#10b981' },
  'consultation.no_show': { emoji: '⚠️', title: 'No-Show Alert', color: '#ef4444' },
  'treatment.presented': { emoji: '📋', title: 'Treatment Presented', color: '#3b82f6' },
  'treatment.accepted': { emoji: '🎯', title: 'Treatment Accepted', color: '#10b981' },
  'contract.signed': { emoji: '🎉', title: 'Contract Signed!', color: '#22c55e' },
  'treatment.completed': { emoji: '🏆', title: 'Treatment Completed', color: '#22c55e' },
  'lead.lost': { emoji: '❌', title: 'Lead Lost', color: '#ef4444' },
  'appointment.booked': { emoji: '📅', title: 'Appointment Booked', color: '#3b82f6' },
  'payment.received': { emoji: '💰', title: 'Payment Received', color: '#22c55e' },
}

/**
 * Send a notification to Slack via Incoming Webhook.
 */
export async function sendSlackNotification(
  event: ConnectorEvent,
  config: SlackConfig
): Promise<ConnectorResult> {
  // Only send events this Slack webhook is subscribed to
  if (config.events.length > 0 && !config.events.includes(event.type)) {
    return {
      connector: 'slack',
      success: true, // Not subscribed — silent skip
    }
  }

  const { lead, metadata } = event.data
  const display = EVENT_DISPLAY[event.type] || { emoji: '📌', title: event.type, color: '#6b7280' }

  try {
    // Build Slack Block Kit message
    const blocks: Record<string, unknown>[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${display.emoji} ${display.title}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Lead:*\n${lead.firstName} ${lead.lastName}`,
          },
          {
            type: 'mrkdwn',
            text: `*Source:*\n${lead.source_type || 'Unknown'}`,
          },
        ],
      },
    ]

    // Add score/qualification if available
    if (lead.ai_score || lead.ai_qualification) {
      blocks.push({
        type: 'section',
        fields: [
          ...(lead.ai_score ? [{
            type: 'mrkdwn',
            text: `*AI Score:*\n${lead.ai_score}/100`,
          }] : []),
          ...(lead.ai_qualification ? [{
            type: 'mrkdwn',
            text: `*Qualification:*\n${lead.ai_qualification.toUpperCase()}`,
          }] : []),
        ],
      })
    }

    // Add treatment value for revenue-bearing events
    if (lead.treatment_value && ['contract.signed', 'treatment.accepted', 'treatment.completed', 'payment.received'].includes(event.type)) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `💵 *Value:* $${lead.treatment_value.toLocaleString()}`,
        },
      })
    }

    // Add stage context for stage changes
    if (metadata?.old_stage && metadata?.new_stage) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `📊 ${metadata.old_stage} → *${metadata.new_stage}*`,
          },
        ],
      })
    }

    // Timestamp
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `⏰ ${new Date(event.timestamp).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`,
        },
      ],
    })

    const payload: Record<string, unknown> = {
      blocks,
      attachments: [{ color: display.color, blocks: [] }],
    }

    if (config.channel) {
      payload.channel = config.channel
    }

    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '')
      return {
        connector: 'slack',
        success: false,
        statusCode: response.status,
        error: `Slack API error: ${errorBody}`,
      }
    }

    return {
      connector: 'slack',
      success: true,
      statusCode: 200,
    }
  } catch (err) {
    return {
      connector: 'slack',
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    }
  }
}
