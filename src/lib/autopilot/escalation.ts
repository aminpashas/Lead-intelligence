/**
 * Escalation System
 *
 * Creates escalation records when the AI can't handle a conversation
 * and notifies staff so a human can take over.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { sendSMS } from '@/lib/messaging/twilio'
import { sendEmail } from '@/lib/messaging/resend'
import { decryptField } from '@/lib/encryption'
import { escapeHtml } from '@/lib/utils'

export type EscalationReason =
  | 'low_confidence'
  | 'patient_requested_human'
  | 'stop_word_detected'
  | 'compliance_flag'
  | 'max_attempts_reached'
  | 'agent_failure'
  | 'sentiment_drop'

export type CreateEscalationInput = {
  organization_id: string
  conversation_id: string
  lead_id: string
  reason: EscalationReason
  ai_notes?: string
  ai_draft_response?: string
  ai_confidence?: number
  agent_type?: string
}

/**
 * Create an escalation record and notify staff.
 */
export async function createEscalation(
  supabase: SupabaseClient,
  input: CreateEscalationInput
): Promise<string | null> {
  const { data, error } = await supabase
    .from('escalations')
    .insert({
      organization_id: input.organization_id,
      conversation_id: input.conversation_id,
      lead_id: input.lead_id,
      reason: input.reason,
      ai_notes: input.ai_notes || null,
      ai_draft_response: input.ai_draft_response || null,
      ai_confidence: input.ai_confidence || null,
      agent_type: input.agent_type || null,
      status: 'pending',
    })
    .select('id')
    .single()

  if (error || !data) {
    console.error('[escalation] Failed to create escalation:', error?.message)
    return null
  }

  // Log activity
  await supabase.from('lead_activities').insert({
    organization_id: input.organization_id,
    lead_id: input.lead_id,
    activity_type: 'escalated_to_human',
    title: `AI escalated conversation: ${formatReason(input.reason)}`,
    description: input.ai_notes || undefined,
    metadata: {
      escalation_id: data.id,
      reason: input.reason,
      confidence: input.ai_confidence,
    },
  })

  // Notify staff (non-blocking)
  notifyStaff(supabase, input).catch((err: unknown) =>
    console.warn('[escalation] Staff notification failed:', err instanceof Error ? err.message : err)
  )

  return data.id
}

/**
 * Notify org admins about a new escalation via SMS/email.
 */
async function notifyStaff(
  supabase: SupabaseClient,
  input: CreateEscalationInput
): Promise<void> {
  // Get org admins
  const { data: admins } = await supabase
    .from('user_profiles')
    .select('id, full_name, phone, email')
    .eq('organization_id', input.organization_id)
    .eq('role', 'admin')
    .limit(5)

  if (!admins || admins.length === 0) return

  // Get lead name for context
  const { data: lead } = await supabase
    .from('leads')
    .select('first_name, last_name')
    .eq('id', input.lead_id)
    .single()

  const leadName = lead
    ? `${decryptField(lead.first_name) || lead.first_name} ${decryptField(lead.last_name) || lead.last_name || ''}`.trim()
    : 'Unknown patient'

  const reasonText = formatReason(input.reason)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.example.com'

  for (const admin of admins) {
    // Send SMS notification
    if (admin.phone) {
      try {
        const phone = decryptField(admin.phone) || admin.phone
        await sendSMS(
          phone,
          `🚨 AI Escalation: ${leadName} needs human attention. Reason: ${reasonText}. ` +
          `Review: ${appUrl}/conversations/${input.conversation_id}`
        )
      } catch {
        // Non-critical — continue to next admin
      }
    }

    // Send email notification
    if (admin.email) {
      try {
        const email = decryptField(admin.email) || admin.email
        await sendEmail({
          to: email,
          subject: `🚨 AI Escalation: ${escapeHtml(leadName)} needs attention`,
          html: `
            <div style="font-family: -apple-system, sans-serif; max-width: 600px; padding: 24px;">
              <h2 style="color: #dc2626;">AI Escalation Alert</h2>
              <p>The AI has flagged a conversation that needs human attention:</p>
              <div style="background: #fef2f2; padding: 16px; border-radius: 8px; margin: 16px 0;">
                <p style="margin: 4px 0;"><strong>Patient:</strong> ${escapeHtml(leadName)}</p>
                <p style="margin: 4px 0;"><strong>Reason:</strong> ${escapeHtml(reasonText)}</p>
                ${input.ai_notes ? `<p style="margin: 4px 0;"><strong>AI Notes:</strong> ${escapeHtml(input.ai_notes)}</p>` : ''}
                ${input.ai_confidence !== undefined ? `<p style="margin: 4px 0;"><strong>AI Confidence:</strong> ${Math.round(input.ai_confidence * 100)}%</p>` : ''}
              </div>
              ${input.ai_draft_response ? `<p><strong>AI's suggested response:</strong></p><blockquote style="border-left: 3px solid #ccc; padding-left: 12px; color: #444;">${escapeHtml(input.ai_draft_response)}</blockquote>` : ''}
              <p><a href="${escapeHtml(appUrl)}/conversations/${escapeHtml(input.conversation_id)}" style="background: #dc2626; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block;">Review Conversation</a></p>
            </div>
          `,
          text: `AI Escalation: ${leadName} needs attention. Reason: ${reasonText}. Review: ${appUrl}/conversations/${input.conversation_id}`,
        })
      } catch {
        // Non-critical
      }
    }
  }
}

function formatReason(reason: EscalationReason): string {
  const map: Record<EscalationReason, string> = {
    low_confidence: 'AI confidence too low',
    patient_requested_human: 'Patient asked to speak with a person',
    stop_word_detected: 'Opt-out / stop word detected',
    compliance_flag: 'HIPAA/compliance concern',
    max_attempts_reached: 'Max follow-up attempts reached',
    agent_failure: 'AI agent error',
    sentiment_drop: 'Patient sentiment dropped sharply',
  }
  return map[reason] || reason
}
