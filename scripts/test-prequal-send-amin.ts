/**
 * QA: fire the INDEPENDENT financing/qualification workflow for the Amin test
 * lead exactly as the Conversations-tab "Pre-Qual" button does — a faithful,
 * service-role mirror of POST /api/leads/[id]/prequal (which needs a staff
 * session we can't mint from a script).
 *
 * It creates/reuses the `/finance/{token}` soft-check link and sends the
 * claim-free pre-qual SMS via the gated `sendSMSToLead` (caller
 * `financing.prequal-manual`), then stamps the financing_application + lead +
 * a `financing_prequal_manual_sent` activity — same side effects as the route.
 *
 * DELIBERATELY SEPARATE from the Setter booking flow. Only run this AFTER the
 * default booking leg is verified, or the Setter's next reply will load this
 * financing context (auto-respond fetches financing context) and re-entangle
 * the two workflows.
 *
 * Usage: npx tsx scripts/test-prequal-send-amin.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { getOrCreateFinancingShareLink } from '../src/lib/financing/share-link'
import { sendSMSToLead } from '../src/lib/messaging/twilio'
import { decryptField } from '../src/lib/encryption'

const ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c'
const LEAD_ID = '62e839ba-90ea-4e77-bcb8-68d5172a2e6b'

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: lead, error } = await supabase
    .from('leads')
    .select('id, first_name, phone, phone_formatted, sms_opt_out, treatment_value, financing_application_id')
    .eq('id', LEAD_ID)
    .single()
  if (error || !lead) throw new Error(`Lead not found: ${error?.message}`)

  const phone = lead.phone_formatted ? decryptField(lead.phone_formatted) : lead.phone ? decryptField(lead.phone) : null
  if (!phone) throw new Error('No phone on lead')
  if (lead.sms_opt_out) throw new Error('Lead is SMS opted-out')

  // Follow-up vs first-touch, mirroring the route.
  const { data: existingApp } = await supabase
    .from('financing_applications')
    .select('id, first_sent_at, submitted_at')
    .eq('lead_id', LEAD_ID)
    .eq('organization_id', ORG_ID)
    .in('status', ['pending', 'in_progress'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; first_sent_at: string | null; submitted_at: string | null }>()

  if (existingApp?.submitted_at) {
    console.log('⛔ Already completed pre-qual — nothing to resend.')
    process.exit(0)
  }
  const isFollowUp = !!existingApp?.first_sent_at

  const link = await getOrCreateFinancingShareLink(supabase, {
    organizationId: ORG_ID,
    leadId: LEAD_ID,
    requestedAmount: lead.treatment_value ?? null,
  })
  if (!link) throw new Error('Could not create financing link')

  const firstName = lead.first_name || 'there'
  const smsBody = isFollowUp
    ? `Hi ${firstName}, just checking back on the payment-options link I sent — it only takes about 2 minutes ` +
      `and it's a soft check that won't affect your credit: ${link.url} If anything's holding you up or you have questions, just reply and I'm happy to help!`
    : `Hi ${firstName}! If it'd help, you can check what payment options you prequalify for in about 2 minutes — ` +
      `it's a soft check that won't affect your credit: ${link.url} No pressure, just here if it's useful!`

  console.log('Pre-qual SMS:\n ', smsBody, `\n  (${smsBody.length} chars)\n  link: ${link.url}\n`)

  const res = await sendSMSToLead({ supabase, leadId: LEAD_ID, to: phone, body: smsBody, caller: 'financing.prequal-manual' })
  console.log('sendSMSToLead result:', JSON.stringify(res))
  if (!res.sent) {
    console.log('⛔ NOT SENT — reason:', res.reason)
    process.exit(2)
  }

  const nowIso = new Date().toISOString()
  await supabase.from('leads')
    .update({ financing_link_sent_at: nowIso, financing_application_id: link.applicationId })
    .eq('id', LEAD_ID).eq('organization_id', ORG_ID)
  await supabase.from('financing_applications')
    .update({ first_sent_at: existingApp?.first_sent_at ?? nowIso, last_sent_at: nowIso, updated_at: nowIso })
    .eq('id', link.applicationId).eq('organization_id', ORG_ID)
  await supabase.from('lead_activities').insert({
    organization_id: ORG_ID,
    lead_id: LEAD_ID,
    activity_type: isFollowUp ? 'financing_prequal_followup_sent' : 'financing_prequal_manual_sent',
    title: `Pre-qualification ${isFollowUp ? 'follow-up' : 'link'} sent via sms (test)`,
    description: `QA mirror of the Pre-Qual button. Patient link: ${link.url}`,
    metadata: { application_id: link.applicationId, share_token: link.shareToken, trigger: 'qa_script', test: true },
  })

  console.log(`\n✅ SENT — independent qualification workflow fired (${isFollowUp ? 'follow-up' : 'first touch'}). sid=${res.sid}`)
}

main().catch((e) => { console.error('FAILED:', e?.message ?? e); process.exit(1) })
