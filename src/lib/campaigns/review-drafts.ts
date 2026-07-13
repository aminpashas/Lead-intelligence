/**
 * Campaign `review_first` draft queue.
 *
 * When a campaign's `autopilot_mode` is 'review_first', its outbound touches are
 * NOT sent automatically — each is written to `public.campaign_review_drafts`
 * for a human to approve or reject. This mirrors the established "draft it and
 * advance the enrollment" pattern the executors already use for the
 * allocation-to-human path (createEscalation / escalateDraft), so review_first
 * does not introduce a paused-enrollment state machine: the enrollment keeps
 * moving, and the human acts on the draft out-of-band.
 *
 * On approval the stored body is sent through the normal consent-gated messaging
 * layer (sendSMSToLead / sendEmailToLead); on rejection the draft is just marked
 * rejected and nothing goes out.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptField } from '@/lib/encryption'
import { logger } from '@/lib/logger'

export interface EnqueueReviewDraftInput {
  organizationId: string
  campaignId: string
  leadId: string
  conversationId: string | null
  channel: 'sms' | 'email'
  subject: string | null
  body: string
}

/**
 * Queue a campaign touch for human review instead of sending it. Best-effort:
 * a write failure is logged but never throws into the executor (the enrollment
 * still advances, same as the escalation-draft path). Returns the draft id, or
 * null on failure.
 */
export async function enqueueCampaignReviewDraft(
  supabase: SupabaseClient,
  input: EnqueueReviewDraftInput
): Promise<string | null> {
  const { data, error } = await supabase
    .from('campaign_review_drafts')
    .insert({
      organization_id: input.organizationId,
      campaign_id: input.campaignId,
      lead_id: input.leadId,
      conversation_id: input.conversationId,
      channel: input.channel,
      subject: input.subject,
      body: input.body,
      status: 'pending',
    })
    .select('id')
    .single<{ id: string }>()

  if (error || !data) {
    logger.warn('Failed to enqueue campaign review draft', {
      campaignId: input.campaignId,
      leadId: input.leadId,
      error: error?.message,
    })
    return null
  }
  return data.id
}

export interface ReviewDecisionResult {
  ok: boolean
  status?: 'approved' | 'rejected'
  sent_via?: 'sms' | 'email' | null
  error?: string
}

/**
 * Approve a pending draft and send it. Org-scoped and idempotent: only a row
 * that is still `pending` in this org is acted on, so a double-click can't
 * double-send. The send itself is consent-gated at the messaging layer.
 */
export async function approveCampaignReviewDraft(
  supabase: SupabaseClient,
  organizationId: string,
  draftId: string,
  reviewerId: string
): Promise<ReviewDecisionResult> {
  // Claim the row: pending → approved in one guarded update so concurrent
  // approvals can't both proceed. If no row comes back it was already handled.
  const { data: draft, error: claimErr } = await supabase
    .from('campaign_review_drafts')
    .update({ status: 'approved', reviewed_by: reviewerId, reviewed_at: new Date().toISOString() })
    .eq('id', draftId)
    .eq('organization_id', organizationId)
    .eq('status', 'pending')
    .select('lead_id, channel, subject, body')
    .maybeSingle<{ lead_id: string; channel: 'sms' | 'email'; subject: string | null; body: string }>()

  if (claimErr || !draft) {
    return { ok: false, error: 'Draft not found or already reviewed' }
  }

  const { data: lead } = await supabase
    .from('leads')
    .select('id, phone_formatted, phone, email')
    .eq('id', draft.lead_id)
    .eq('organization_id', organizationId)
    .single()

  if (!lead) return { ok: false, status: 'approved', sent_via: null, error: 'Lead not found' }

  let sent = false
  if (draft.channel === 'sms') {
    const phone = lead.phone_formatted ? decryptField(lead.phone_formatted) : lead.phone ? decryptField(lead.phone) : null
    if (phone) {
      const { sendSMSToLead } = await import('@/lib/messaging/twilio')
      const res = await sendSMSToLead({ supabase, leadId: lead.id, to: phone, body: draft.body, caller: 'campaign.review-approved' })
      sent = res.sent
    }
  } else {
    const email = lead.email ? decryptField(lead.email) : null
    if (email) {
      const { sendEmailToLead } = await import('@/lib/messaging/resend')
      const html = `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:24px;">${draft.body.replace(/\n/g, '<br>')}</div>`
      const res = await sendEmailToLead({ supabase, leadId: lead.id, to: email, subject: draft.subject || 'A note from our team', html, text: draft.body, caller: 'campaign.review-approved' })
      sent = res.sent
    }
  }

  return { ok: true, status: 'approved', sent_via: sent ? draft.channel : null }
}

/** Reject a pending draft — mark it rejected, send nothing. Org-scoped + idempotent. */
export async function rejectCampaignReviewDraft(
  supabase: SupabaseClient,
  organizationId: string,
  draftId: string,
  reviewerId: string
): Promise<ReviewDecisionResult> {
  const { data, error } = await supabase
    .from('campaign_review_drafts')
    .update({ status: 'rejected', reviewed_by: reviewerId, reviewed_at: new Date().toISOString() })
    .eq('id', draftId)
    .eq('organization_id', organizationId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()

  if (error || !data) return { ok: false, error: 'Draft not found or already reviewed' }
  return { ok: true, status: 'rejected', sent_via: null }
}
