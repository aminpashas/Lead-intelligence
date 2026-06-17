/**
 * A2P 10DLC status monitor.
 *
 * US SMS is blocked until the Twilio us_app_to_person campaign bound to our
 * Messaging Service reaches VERIFIED. This cron polls Twilio's compliance API,
 * snapshots brand + campaign status into public.a2p_status, and posts a Slack
 * alert on any transition (VERIFIED = unblock, FAILED = needs resubmission).
 *
 * It deliberately does NOT auto-enable US sending — flipping the per-org
 * `us_sms_enabled` flag stays a human decision after VERIFIED is confirmed.
 *
 * Schedule: every 6h (vercel.json). Heartbeats via withCron.
 */

import twilio from 'twilio'
import { withCron } from '@/lib/cron/with-cron'
import { detectA2pTransition } from '@/lib/messaging/a2p'
import { postSlack } from '@/lib/alerts/slack'

export const POST = withCron('a2p-status', async ({ supabase }) => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  const serviceSid = process.env.TWILIO_MESSAGING_SERVICE_SID
  const brandSid = process.env.TWILIO_A2P_BRAND_SID

  // Nothing to check until the messaging service (which the campaign binds to) is configured.
  if (!accountSid || !authToken || !serviceSid) {
    return { status: 'skipped', items: 0, data: { reason: 'twilio_not_configured' } }
  }

  const client = twilio(accountSid, authToken)

  // Campaign status lives on the us_app_to_person resource under the service.
  const campaigns = await client.messaging.v1.services(serviceSid).usAppToPerson.list({ limit: 5 })
  const campaign = campaigns[0]
  if (!campaign) {
    return { status: 'skipped', items: 0, data: { reason: 'no_campaign_on_service' } }
  }
  const campaignSid = campaign.sid
  const campaignStatus = campaign.campaignStatus ?? null

  // Brand status is optional context (only fetched when the brand SID is configured).
  let brandStatus: string | null = null
  if (brandSid) {
    try {
      const brand = await client.messaging.v1.brandRegistrations(brandSid).fetch()
      brandStatus = brand.status ?? null
    } catch (err) {
      console.warn('[a2p-status] brand fetch failed', err)
    }
  }

  // Compare against the last snapshot to detect a transition.
  const { data: prev } = await supabase
    .from('a2p_status')
    .select('campaign_status')
    .eq('campaign_sid', campaignSid)
    .maybeSingle()

  const transition = detectA2pTransition(prev?.campaign_status ?? null, campaignStatus)
  const nowIso = new Date().toISOString()

  await supabase.from('a2p_status').upsert(
    {
      campaign_sid: campaignSid,
      campaign_status: campaignStatus,
      previous_campaign_status: prev?.campaign_status ?? null,
      brand_sid: brandSid ?? null,
      brand_status: brandStatus,
      last_checked_at: nowIso,
      ...(transition.changed ? { last_transition_at: nowIso } : {}),
      raw: { campaign_status: campaignStatus, brand_status: brandStatus },
      updated_at: nowIso,
    },
    { onConflict: 'campaign_sid' }
  )

  if (transition.changed && transition.severity !== 'none') {
    await postSlack(transition.message)
  }

  return {
    items: 1,
    data: {
      campaign_sid: campaignSid,
      campaign_status: campaignStatus,
      brand_status: brandStatus,
      transition: transition.changed ? transition.severity : 'none',
    },
  }
})

export const GET = POST
