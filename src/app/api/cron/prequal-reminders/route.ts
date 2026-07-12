import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { isFlagEnabled } from '@/lib/org/flags'
import { getPublicAppUrl } from '@/lib/app-url'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { sendEmailToLead } from '@/lib/messaging/resend'
import { decryptField } from '@/lib/encryption'
import { auditPHITransmission } from '@/lib/hipaa-audit'
import { escapeHtml } from '@/lib/utils'
import { logger } from '@/lib/logger'

/**
 * POST /api/cron/prequal-reminders
 *
 * Daily nudge for patients who were sent a pre-qualification link but haven't
 * filled it out. Cadence is +1d / +3d / +7d after the FIRST send, capped at 3
 * automated reminders — after that we leave it to staff to follow up by hand.
 *
 * Every send is consent-gated at the messaging layer (a muted/opted-out channel
 * simply returns { sent: false }), so this endpoint never bypasses TCPA/CAN-SPAM.
 * A submitted link is never nudged — the query filters on `submitted_at IS NULL`,
 * which is stamped the instant the patient completes the form (before the async
 * lender waterfall even runs), so there is no "already applied" false nudge.
 *
 * Protected by CRON_SECRET.
 */

// Days after first_sent_at at which reminder #1, #2, #3 become due.
const CADENCE_DAYS = [1, 3, 7]
const MAX_REMINDERS = CADENCE_DAYS.length
const DAY_MS = 24 * 60 * 60 * 1000

type PendingApp = {
  id: string
  organization_id: string
  lead_id: string
  share_token: string | null
  first_sent_at: string
  reminder_count: number
  last_reminder_at: string | null
  expires_at: string
}

type LeadContact = {
  first_name: string | null
  phone: string | null
  phone_formatted: string | null
  email: string | null
  sms_opt_out: boolean | null
  email_opt_out: boolean | null
}

/** Reminder copy escalates in gentleness, and every variant surfaces the "reply
 *  with questions or concerns" off-ramp the practice asked for. `index` is 0-based. */
function reminderCopy(index: number, firstName: string, url: string) {
  const name = firstName || 'there'
  const safeName = escapeHtml(name)
  const safeUrl = escapeHtml(url)
  const variants = [
    {
      sms: `Hi ${name}, just a quick nudge on the payment-options link I sent — it takes about 2 minutes and it's a soft check that won't affect your credit: ${url} Any questions, just reply!`,
      subject: 'A quick nudge on your financing options',
      lead: `Just a quick nudge on the payment-options check I sent over — it only takes a couple of minutes and won't affect your credit score.`,
      cta: 'See my options',
      close: `Any questions at all, just reply — happy to help.`,
    },
    {
      sms: `Hi ${name}, still here whenever you'd like to check your payment options: ${url} If something's giving you pause, just reply and I'll help sort it out.`,
      subject: 'Still here when you\'re ready',
      lead: `No rush at all — your payment-options link is still open whenever you'd like to take a look.`,
      cta: 'Check my options',
      close: `If anything's giving you pause, reply and I'll help you sort it out.`,
    },
    {
      sms: `Hi ${name}, last little nudge on this — your financing options link is still open: ${url} No pressure, and I'm glad to answer anything if you reply.`,
      subject: 'Your financing options link is still open',
      lead: `Just a final note — your financing options link is still open if it's useful.`,
      cta: 'View my options',
      close: `No pressure either way, and I'm glad to answer any questions or concerns if you reply.`,
    },
  ]
  const v = variants[Math.min(index, variants.length - 1)]
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;color:#111;">
      <p>Hi ${safeName},</p>
      <p>${v.lead} It uses a <strong>soft credit check that won't affect your credit score</strong>.</p>
      <p><a href="${safeUrl}" style="background:#10b981;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;display:inline-block;font-weight:bold;">${v.cta}</a></p>
      <p>${v.close}</p>
    </div>
  `
  return { sms: v.sms, subject: v.subject, html }
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  // Fail closed: an unset CRON_SECRET must not make this endpoint public.
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()
  const results = { scanned: 0, due: 0, sent: 0, skipped: 0, errors: 0 }
  const nowMs = Date.now()

  // Candidate links: sent at least once, still pending + unfilled + unexpired,
  // and under the reminder cap. The partial index backs this filter.
  const { data: appsRaw, error } = await supabase
    .from('financing_applications')
    .select('id, organization_id, lead_id, share_token, first_sent_at, reminder_count, last_reminder_at, expires_at')
    .eq('status', 'pending')
    .is('submitted_at', null)
    .not('first_sent_at', 'is', null)
    .lt('reminder_count', MAX_REMINDERS)
    .gt('expires_at', new Date().toISOString())

  if (error) {
    logger.error('[cron/prequal-reminders] Query failed', { error: error.message })
    return NextResponse.json({ error: 'Query failed' }, { status: 500 })
  }

  const apps = (appsRaw ?? []) as PendingApp[]
  results.scanned = apps.length

  // Cache the per-org feature flag so we resolve it once per organization.
  const flagCache = new Map<string, boolean>()

  for (const app of apps) {
    try {
      // Is the next reminder actually due yet? dueAt is computed from the fixed
      // first_sent_at, so once reminder_count increments the next one lands later.
      const dueOffsetDays = CADENCE_DAYS[app.reminder_count]
      const dueAtMs = new Date(app.first_sent_at).getTime() + dueOffsetDays * DAY_MS
      if (nowMs < dueAtMs) continue
      results.due++

      // Respect the org-level pre-qual switch — a practice that turned the
      // feature off should not have the cron nudging on its behalf.
      let enabled = flagCache.get(app.organization_id)
      if (enabled === undefined) {
        enabled = await isFlagEnabled(supabase, app.organization_id, 'financing_prequal_enabled')
        flagCache.set(app.organization_id, enabled)
      }
      if (!enabled) { results.skipped++; continue }

      if (!app.share_token) { results.skipped++; continue }

      // Load + decrypt the lead's contact info. (Service client isn't schema-
      // generically typed, so annotate the row via cast rather than `.single<T>()`.)
      const { data: leadRow } = await supabase
        .from('leads')
        .select('first_name, phone, phone_formatted, email, sms_opt_out, email_opt_out')
        .eq('id', app.lead_id)
        .eq('organization_id', app.organization_id)
        .single()

      const leadRaw = leadRow as LeadContact | null
      if (!leadRaw) { results.skipped++; continue }

      const phone = leadRaw.phone_formatted
        ? decryptField(leadRaw.phone_formatted)
        : leadRaw.phone ? decryptField(leadRaw.phone) : null
      const email = leadRaw.email ? decryptField(leadRaw.email) : null

      const smsReachable = !!phone && !leadRaw.sms_opt_out
      const emailReachable = !!email && !leadRaw.email_opt_out
      if (!smsReachable && !emailReachable) { results.skipped++; continue }

      const url = `${getPublicAppUrl()}/finance/${app.share_token}`
      const copy = reminderCopy(app.reminder_count, leadRaw.first_name || 'there', url)

      const sentVia: string[] = []

      if (smsReachable && phone) {
        try {
          await auditPHITransmission(
            { supabase, organizationId: app.organization_id, actorType: 'cron' },
            'lead', app.lead_id, 'twilio_sms', ['phone']
          )
          const res = await sendSMSToLead({
            supabase, leadId: app.lead_id, to: phone, body: copy.sms,
            caller: 'financing.prequal-reminder',
          })
          if (res.sent) sentVia.push('sms')
        } catch { /* fall through to email */ }
      }

      if (sentVia.length === 0 && emailReachable && email) {
        try {
          await auditPHITransmission(
            { supabase, organizationId: app.organization_id, actorType: 'cron' },
            'lead', app.lead_id, 'resend_email', ['email']
          )
          const res = await sendEmailToLead({
            supabase, leadId: app.lead_id, to: email, subject: copy.subject, html: copy.html,
            caller: 'financing.prequal-reminder',
          })
          if (res.sent) sentVia.push('email')
        } catch { /* nothing sent */ }
      }

      if (sentVia.length === 0) { results.skipped++; continue }

      const nowIso = new Date().toISOString()
      const newCount = app.reminder_count + 1
      await supabase
        .from('financing_applications')
        .update({ reminder_count: newCount, last_reminder_at: nowIso, last_sent_at: nowIso, updated_at: nowIso })
        .eq('id', app.id)

      await supabase.from('lead_activities').insert({
        organization_id: app.organization_id,
        lead_id: app.lead_id,
        activity_type: 'financing_prequal_reminder_sent',
        title: `Pre-qualification reminder ${newCount}/${MAX_REMINDERS} sent via ${sentVia.join(' & ')}`,
        description: `Automated nudge — patient has not completed the pre-qual link yet. Link: ${url}`,
        metadata: {
          application_id: app.id,
          share_token: app.share_token,
          reminder_number: newCount,
          sent_via: sentVia,
          trigger: 'auto_reminder',
        },
      }).catch(() => { /* breadcrumb only */ })

      results.sent++
    } catch (err) {
      logger.warn('[cron/prequal-reminders] Reminder failed', {
        applicationId: app.id,
        error: err instanceof Error ? err.message : err,
      })
      results.errors++
    }
  }

  return NextResponse.json({ success: true, timestamp: new Date().toISOString(), results })
}
