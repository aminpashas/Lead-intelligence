/**
 * Financing Readiness Detection Engine
 *
 * Determines WHEN a lead is ready to receive a financing link.
 * Prevents sending too early (scares them) or too late (missed window).
 *
 * Uses a multi-signal scoring system with smart timing rules
 * to auto-trigger financing link delivery at the optimal moment.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Lead, FinancialSignals } from '@/types/database'
import { sendSMS } from '@/lib/messaging/twilio'
import { sendEmail } from '@/lib/messaging/resend'
import { decryptField } from '@/lib/encryption'
import { escapeHtml } from '@/lib/utils'
import { logger } from '@/lib/logger'

export type ReadinessAssessment = {
  score: number          // 0-100
  is_ready: boolean      // true if should trigger financing link
  reason: string         // human-readable explanation
  blocking_factors: string[]  // what's preventing readiness
  boosting_factors: string[]  // what's driving readiness up
}

// ── Readiness Score Calculator ─────────────────────────────────

/**
 * Calculate comprehensive financing readiness using all available signals.
 * This goes beyond the basic FinancialSignals.readiness_score by incorporating
 * engagement, pipeline stage, and temporal factors.
 */
export function assessFinancingReadiness(lead: Partial<Lead>): ReadinessAssessment {
  let score = 0
  const boosting: string[] = []
  const blocking: string[] = []

  const signals = (lead.financial_signals || {}) as Partial<FinancialSignals>

  // ── Conversation-based financial signals (40 points max) ────
  if (signals.financing_interest === 'high') {
    score += 25; boosting.push('Expressed strong financing interest')
  } else if (signals.financing_interest === 'medium') {
    score += 12; boosting.push('Asked about pricing')
  }

  if (signals.budget_monthly) {
    score += 10; boosting.push(`Mentioned monthly budget: $${signals.budget_monthly}/mo`)
  }

  if (signals.has_savings) {
    score += 5; boosting.push('Has savings available')
  }

  // ── Lead engagement signals (20 points max) ─────────────────
  const engagement = lead.engagement_score ?? 0
  if (engagement > 60) {
    score += 10; boosting.push('High engagement score')
  } else if (engagement > 30) {
    score += 5; boosting.push('Moderate engagement')
  }

  const totalReceived = lead.total_messages_received ?? 0
  if (totalReceived >= 3) {
    score += 10; boosting.push(`Responded to ${totalReceived} messages`)
  } else if (totalReceived >= 1) {
    score += 5; boosting.push('Has responded at least once')
  } else {
    blocking.push('No responses yet')
  }

  // ── Pipeline stage signals (20 points max) ──────────────────
  const status = lead.status ?? 'new'
  if (status === 'consultation_completed' || status === 'treatment_presented') {
    score += 20; boosting.push('Post-consultation — optimal financing window')
  } else if (status === 'consultation_scheduled') {
    score += 10; boosting.push('Consultation scheduled')
  } else if (status === 'qualified') {
    score += 8; boosting.push('Lead is qualified')
  } else if (status === 'contacted') {
    score += 3
  }

  // ── Pre-existing financial data (10 points max) ─────────────
  if (lead.has_dental_insurance) {
    score += 5; boosting.push('Has dental insurance')
  }
  if (lead.financing_interest === 'financing_needed') {
    score += 5; boosting.push('Indicated financing needed during intake')
  }
  if (lead.financing_interest === 'cash_pay') {
    score += 10; boosting.push('Cash pay — may not need financing')
  }

  // ── Personality/psychology boost (5 points max) ─────────────
  const personality = lead.personality_profile as Record<string, unknown> | null
  if (personality?.personality_type === 'D') {
    score += 5; boosting.push('Dominant personality — responds to direct offers')
  } else if (personality?.personality_type === 'C') {
    score += 3; boosting.push('Conscientious — values having all info')
  }

  // ── Time in pipeline boost (5 points max) ───────────────────
  if (lead.created_at) {
    const daysInPipeline = (Date.now() - new Date(lead.created_at).getTime()) / (1000 * 60 * 60 * 24)
    if (daysInPipeline >= 7 && totalReceived >= 2) {
      score += 5; boosting.push(`${Math.round(daysInPipeline)} days in pipeline with engagement`)
    }
  }

  // ── Blocking factors (subtract) ─────────────────────────────
  const barriers = signals.barriers || []
  if (barriers.includes('no_funds')) {
    score -= 15; blocking.push('Expressed inability to pay')
  }
  if (barriers.includes('employment_instability')) {
    score -= 15; blocking.push('Employment instability')
  }
  if (barriers.includes('credit_concern')) {
    score -= 10; blocking.push('Credit concerns')
  }
  if (barriers.includes('timing_barrier')) {
    score -= 5; blocking.push('Timing not right')
  }

  // Already sent and not approved — don't resend
  if (lead.financing_link_sent_at && !lead.financing_approved) {
    const daysSinceSent = (Date.now() - new Date(lead.financing_link_sent_at).getTime()) / (1000 * 60 * 60 * 24)
    if (daysSinceSent < 7) {
      score -= 30; blocking.push('Financing link already sent within last 7 days')
    }
  }

  score = Math.max(0, Math.min(100, score))

  // ── Smart timing rules (hard blocks) ────────────────────────
  const hardBlock = checkHardBlocks(lead, totalReceived)
  if (hardBlock) {
    blocking.push(hardBlock)
    return {
      score: Math.min(score, 60), // cap below threshold
      is_ready: false,
      reason: hardBlock,
      blocking_factors: blocking,
      boosting_factors: boosting,
    }
  }

  const isReady = score >= 65
  const reason = isReady
    ? `Lead is ready for financing (score: ${score}). ${boosting[0] || ''}`
    : `Lead not yet ready (score: ${score}). ${blocking[0] || 'Needs more engagement.'}`

  return { score, is_ready: isReady, reason, blocking_factors: blocking, boosting_factors: boosting }
}

/**
 * Check hard-block rules that should NEVER be violated.
 */
function checkHardBlocks(lead: Partial<Lead>, messagesReceived: number): string | null {
  // Never send financing in the first message
  if ((lead.total_messages_sent ?? 0) === 0) {
    return 'Cannot send financing link before first outreach'
  }

  // Lead must have responded at least twice
  if (messagesReceived < 2) {
    return 'Lead has not responded to at least 2 messages'
  }

  // Don't send to opted-out leads
  if (lead.sms_opt_out && lead.email_opt_out) {
    return 'Lead has opted out of all channels'
  }

  // Don't send to disqualified or lost leads
  if (lead.status === 'disqualified' || lead.status === 'lost') {
    return 'Lead is disqualified or lost'
  }

  return null
}

// ── Auto-Trigger Financing Link ────────────────────────────────

/**
 * Check if a lead is ready and automatically send the financing link.
 * Called after every financial signal update.
 */
export async function checkAndTriggerFinancing(
  supabase: SupabaseClient,
  leadId: string,
  organizationId: string
): Promise<{ triggered: boolean; assessment: ReadinessAssessment }> {
  // Load full lead data
  const { data: lead } = await supabase
    .from('leads')
    .select('id, first_name, last_name, email, phone, phone_formatted, status, engagement_score, total_messages_sent, total_messages_received, has_dental_insurance, financing_interest, financing_link_sent_at, financing_approved, financing_readiness_score, financial_signals, personality_profile, sms_opt_out, email_opt_out, created_at, treatment_value, organization_id, budget_range')
    .eq('id', leadId)
    .single()

  if (!lead) {
    return { triggered: false, assessment: { score: 0, is_ready: false, reason: 'Lead not found', blocking_factors: [], boosting_factors: [] } }
  }

  const assessment = assessFinancingReadiness(lead)

  // Update the readiness score in DB
  await supabase
    .from('leads')
    .update({ financing_readiness_score: assessment.score })
    .eq('id', leadId)

  if (!assessment.is_ready) {
    return { triggered: false, assessment }
  }

  // Already has financing link sent recently — skip
  if (lead.financing_link_sent_at) {
    const daysSince = (Date.now() - new Date(lead.financing_link_sent_at).getTime()) / (1000 * 60 * 60 * 24)
    if (daysSince < 7) {
      return { triggered: false, assessment }
    }
  }

  // Already approved — no need to send again
  if (lead.financing_approved) {
    return { triggered: false, assessment }
  }

  // Send the financing link!
  const sent = await sendFinancingLink(supabase, lead as Lead, organizationId)

  if (sent) {
    await supabase
      .from('leads')
      .update({ financing_link_sent_at: new Date().toISOString() })
      .eq('id', leadId)

    await supabase.from('lead_activities').insert({
      organization_id: organizationId,
      lead_id: leadId,
      activity_type: 'financing_link_auto_sent',
      title: 'Financing link auto-sent (AI readiness trigger)',
      description: `Readiness score: ${assessment.score}/100. ${assessment.reason}`,
      metadata: {
        readiness_score: assessment.score,
        boosting_factors: assessment.boosting_factors,
        trigger: 'auto_readiness',
      },
    })

    logger.info('Financing link auto-triggered', {
      leadId,
      readinessScore: assessment.score,
      reason: assessment.reason,
    })
  }

  return { triggered: sent, assessment }
}

/**
 * Send a personalized financing link via SMS (preferred) or email.
 */
async function sendFinancingLink(
  supabase: SupabaseClient,
  lead: Lead,
  organizationId: string
): Promise<boolean> {
  const firstName = lead.first_name || 'there'

  // Load organization for branding
  const { data: org } = await supabase
    .from('organizations')
    .select('name, website')
    .eq('id', organizationId)
    .single()

  const practiceName = org?.name || 'our practice'

  // Check if there's already a financing application with share token
  const { data: existingApp } = await supabase
    .from('financing_applications')
    .select('share_token')
    .eq('lead_id', lead.id)
    .in('status', ['pending', 'in_progress'])
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  const financeUrl = existingApp?.share_token
    ? `${process.env.NEXT_PUBLIC_APP_URL}/finance/${existingApp.share_token}`
    : `${process.env.NEXT_PUBLIC_APP_URL}/qualify/${organizationId}`

  // Personalize message based on financial signals
  const signals = (lead.financial_signals || {}) as Partial<FinancialSignals>
  const monthly = signals.budget_monthly
    ? `We can likely get you to around $${signals.budget_monthly}/mo. `
    : 'Most patients qualify for payments as low as $199/mo. '

  // Try SMS first (higher engagement)
  if (!lead.sms_opt_out && lead.phone_formatted) {
    try {
      const phone = decryptField(lead.phone_formatted) || ''
      if (phone) {
        const smsBody = `Hi ${firstName}! 🎉 Great news — ${monthly}It only takes 2 minutes to see your options (soft check, won't affect your credit): ${financeUrl} Questions? Just reply!`
        await sendSMS(phone, smsBody)
        return true
      }
    } catch (err) {
      logger.warn('Financing link SMS failed, trying email', { leadId: lead.id, error: err instanceof Error ? err.message : err })
    }
  }

  // Fallback to email
  if (!lead.email_opt_out && lead.email) {
    try {
      const email = decryptField(lead.email) || ''
      if (email) {
        await sendEmail({
          to: email,
          subject: `${firstName}, your personalized financing options are ready`,
          html: buildFinancingEmailHTML(firstName, practiceName, financeUrl, monthly),
        })
        return true
      }
    } catch (err) {
      logger.warn('Financing link email also failed', { leadId: lead.id, error: err instanceof Error ? err.message : err })
    }
  }

  return false
}

function buildFinancingEmailHTML(firstName: string, practiceName: string, url: string, monthlyNote: string): string {
  // PROD-8: Escape user-controlled values to prevent email HTML injection
  const safeFirstName = escapeHtml(firstName)
  const safePracticeName = escapeHtml(practiceName)
  const safeUrl = escapeHtml(url)
  const safeMonthlyNote = escapeHtml(monthlyNote)
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 32px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 24px;">Your Financing Options Are Ready! 🎉</h1>
      </div>
      <div style="padding: 32px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <p style="font-size: 16px; color: #374151;">Hi ${safeFirstName},</p>
        <p style="font-size: 16px; color: #374151;">${safeMonthlyNote}We've put together personalized financing options just for you.</p>
        
        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; margin: 24px 0;">
          <p style="margin: 4px 0; color: #166534;"><strong>✅ 2-minute application</strong></p>
          <p style="margin: 4px 0; color: #166534;"><strong>✅ Soft credit check — won't affect your score</strong></p>
          <p style="margin: 4px 0; color: #166534;"><strong>✅ See multiple options instantly</strong></p>
          <p style="margin: 4px 0; color: #166534;"><strong>✅ No obligation</strong></p>
        </div>
        
        <div style="text-align: center; margin: 32px 0;">
          <a href="${safeUrl}" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 16px 40px; text-decoration: none; border-radius: 8px; font-size: 18px; font-weight: 600; display: inline-block;">See My Options →</a>
        </div>
        
        <p style="font-size: 14px; color: #6b7280; text-align: center;">Questions? Just reply to this email — we're here to help.</p>
        <p style="font-size: 14px; color: #6b7280; text-align: center;">— ${safePracticeName}</p>
      </div>
    </div>
  `
}
