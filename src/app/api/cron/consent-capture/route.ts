/**
 * Re-permission (consent-capture) batch cron.
 *
 * Emails the hosted /optin opt-in to a tagged segment of `unknown`-consent leads
 * to EARN consent — the lawful on-ramp before any automated SMS or AI-voice
 * outreach (see docs/re-permission-campaign-playbook.md). Built for the
 * full-arch cold pool (tag `full-arch-cold`); a confirmed opt-in grants email +
 * SMS + voice consent so the AI voice agent can then legally call.
 *
 * GATES — both required to send a real email:
 *   1. per-org `consent_capture` feature flag = ON  (filters which orgs run)
 *   2. global env CONSENT_CAPTURE_SEND = 'true'      (master send switch)
 * Without the env switch the cron DRY-RUNS: it reports who it would email, mints
 * no tokens, and sends nothing. Daily volume is capped (email warmup ramp), and
 * leads re-permissioned within the cooldown window are skipped.
 *
 * Schedule: daily (vercel.json). Heartbeats + cron-auth via withCron.
 */

import { withCron } from '@/lib/cron/with-cron'
import { decryptField } from '@/lib/encryption'
import { sendEmail } from '@/lib/messaging/resend'
import {
  generateConsentToken,
  consentTokenExpiry,
  buildOptInUrl,
  optInEmailTemplate,
} from '@/lib/consent/capture'
import {
  CONSENT_CAPTURE_REPERMISSION_TAG,
  CONSENT_CAPTURE_CHANNELS,
  CONSENT_CAPTURE_TOKEN_COOLDOWN_DAYS,
  CONSENT_CAPTURE_DEFAULT_DAILY_CAP,
  consentCaptureBudget,
  consentCaptureSendEnabled,
} from '@/lib/consent/campaign'

export const runtime = 'nodejs'
export const maxDuration = 300

export const POST = withCron('consent-capture', async ({ supabase }) => {
  const tag = process.env.CONSENT_CAPTURE_TAG || CONSENT_CAPTURE_REPERMISSION_TAG
  const dailyCap = Number(process.env.CONSENT_CAPTURE_DAILY_CAP ?? CONSENT_CAPTURE_DEFAULT_DAILY_CAP)
  const live = consentCaptureSendEnabled(process.env)
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || ''

  if (live && !baseUrl) {
    return { status: 'skipped', items: 0, data: { reason: 'app_url_not_configured' } }
  }

  // Only orgs that have opted into the consent-capture flow.
  type OrgRow = { id: string; name: string | null; feature_flags: Record<string, unknown> | null }
  const { data: orgs } = await supabase
    .from('organizations')
    .select('id, name, feature_flags')
  const enabledOrgs = ((orgs ?? []) as OrgRow[]).filter(
    (o) => o.feature_flags?.consent_capture === true,
  )
  if (enabledOrgs.length === 0) {
    return { status: 'skipped', items: 0, data: { reason: 'no_org_with_consent_capture' } }
  }

  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const cooldownIso = new Date(
    Date.now() - CONSENT_CAPTURE_TOKEN_COOLDOWN_DAYS * 86_400_000,
  ).toISOString()

  let sent = 0
  let wouldSend = 0
  let skippedNoEmail = 0
  let errors = 0
  const perOrg: Array<Record<string, unknown>> = []

  for (const org of enabledOrgs) {
    // Daily cap: subtract tokens already minted today for this org (warmup ramp).
    const { count: sentToday } = await supabase
      .from('consent_capture_tokens')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', org.id)
      .gte('created_at', startOfDay.toISOString())
    const budget = consentCaptureBudget(dailyCap, sentToday ?? 0)
    if (budget <= 0) {
      perOrg.push({ org: org.id, sent: 0, reason: 'daily_cap_reached' })
      continue
    }

    // Candidate segment: tagged, has an email, email not declined/opted-out, and
    // still `unknown` on SMS or voice (i.e. there is consent left to earn).
    type CandidateRow = {
      id: string
      first_name: string | null
      email: string | null
      email_opt_out: boolean | null
      email_consent_status: string | null
      sms_consent_status: string | null
      voice_consent_status: string | null
    }
    const { data: candidates } = await supabase
      .from('leads')
      .select(
        'id, first_name, email, email_opt_out, email_consent_status, sms_consent_status, voice_consent_status',
      )
      .eq('organization_id', org.id)
      .contains('tags', [tag])
      .not('email', 'is', null)
      .neq('email_opt_out', true)
      .neq('email_consent_status', 'declined')
      .or('sms_consent_status.eq.unknown,voice_consent_status.eq.unknown')
      .limit(budget * 3)

    // Drop anyone already re-permissioned within the cooldown window.
    const { data: recent } = await supabase
      .from('consent_capture_tokens')
      .select('lead_id')
      .eq('organization_id', org.id)
      .gte('created_at', cooldownIso)
    const recentLeadIds = new Set(((recent ?? []) as Array<{ lead_id: string }>).map((r) => r.lead_id))
    const batch = ((candidates ?? []) as CandidateRow[])
      .filter((c) => !recentLeadIds.has(c.id))
      .slice(0, budget)

    // Dry run: report the would-send count, mint nothing, send nothing.
    if (!live) {
      wouldSend += batch.length
      perOrg.push({ org: org.id, dry_run: true, would_send: batch.length, budget })
      continue
    }

    let orgSent = 0
    for (const lead of batch) {
      const email = decryptField(lead.email) || lead.email
      if (!email) {
        skippedNoEmail++
        continue
      }
      const token = generateConsentToken()
      const { error: tokenErr } = await supabase.from('consent_capture_tokens').insert({
        organization_id: org.id,
        lead_id: lead.id,
        token,
        channels: CONSENT_CAPTURE_CHANNELS,
        expires_at: consentTokenExpiry(),
      })
      if (tokenErr) {
        errors++
        continue
      }
      try {
        const url = buildOptInUrl(baseUrl, token)
        const tmpl = optInEmailTemplate({
          orgName: org.name ?? '',
          firstName: lead.first_name,
          url,
          channels: CONSENT_CAPTURE_CHANNELS,
        })
        await sendEmail({ to: email, subject: tmpl.subject, html: tmpl.html, text: tmpl.text })
        orgSent++
        sent++
      } catch {
        // Token already minted (lead is now in cooldown); a failed send is not
        // retried until the cooldown lapses. Counted, not silently dropped.
        errors++
      }
    }
    perOrg.push({ org: org.id, sent: orgSent, budget })
  }

  return {
    items: live ? sent : wouldSend,
    data: {
      mode: live ? 'live' : 'dry_run',
      tag,
      daily_cap: dailyCap,
      sent,
      would_send: wouldSend,
      skipped_no_email: skippedNoEmail,
      errors,
      orgs: perOrg,
    },
  }
})

export const GET = POST
