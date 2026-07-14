import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { scoreLead } from '@/lib/ai/scoring'
import {
  validateOrgId,
  getRawBodyAndParsed,
  applyDistributedRateLimit,
  verifyWebhookSignature,
} from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { dispatchConnectorEvent, buildConnectorLeadData } from '@/lib/connectors'
import { ingestLead } from '@/lib/leads/ingest'
import {
  getGoogleLeadFormConfig,
  verifyGoogleKey,
  parseGoogleLeadColumns,
  hasGoogleContact,
  isGoogleTestLead,
} from '@/lib/connectors/google-ads/lead-forms'

// Campaign vertical is carried in the webhook URL (?vertical=tmj) because
// Google's payload has only opaque campaign/form ids. Non-implant verticals
// are tagged for vertical-aware scoring and never arm speed-to-lead — the
// setter playbook is implant-specific.
const TREATMENT_VERTICALS = ['implant', 'tmj', 'sleep_apnea'] as const
type Vertical = (typeof TREATMENT_VERTICALS)[number]

// POST /api/webhooks/google-ads — Google Ads Lead Form Extensions webhook
export async function POST(request: NextRequest) {
  const rlError = await applyDistributedRateLimit(request, RATE_LIMITS.webhook, 'wh-google-ads')
  if (rlError) return rlError

  const { rawBody, parsed } = await getRawBodyAndParsed(request)
  const body = parsed as Record<string, unknown>

  const url = new URL(request.url)
  const orgResult = await validateOrgId(url.searchParams.get('org'))
  if (orgResult instanceof NextResponse) return orgResult
  const { orgId } = orgResult

  const verticalParam = url.searchParams.get('vertical')
  const vertical: Vertical = (TREATMENT_VERTICALS as readonly string[]).includes(verticalParam ?? '')
    ? (verticalParam as Vertical)
    : 'implant'

  const supabase = createServiceClient()
  const cfg = await getGoogleLeadFormConfig(supabase, orgId)

  // Auth: Google's real contract echoes the form "Key" in `google_key` (no HMAC
  // header). Prefer that when configured. Fall back to the shared WEBHOOK_SECRET
  // HMAC only when no key is set, so signed relay traffic still works.
  if (cfg.leadFormKey) {
    if (!verifyGoogleKey(body.google_key as string | undefined, cfg.leadFormKey)) {
      return NextResponse.json({ error: 'Invalid google_key' }, { status: 401 })
    }
  } else {
    const sigError = verifyWebhookSignature(rawBody, request.headers.get('x-webhook-signature'))
    if (sigError) return sigError
  }

  // Google's "Send test data" button posts is_test — ack without creating a lead.
  if (isGoogleTestLead(body)) {
    return NextResponse.json({ success: true, action: 'test_ignored' })
  }

  const parsedLead = parseGoogleLeadColumns(body)
  if (!hasGoogleContact(parsedLead)) {
    return NextResponse.json({ success: true, action: 'no_contact' })
  }

  let result
  try {
    result = await ingestLead(
      supabase,
      {
        organizationId: orgId,
        firstName: parsedLead.firstName,
        lastName: parsedLead.lastName,
        email: parsedLead.email,
        phoneRaw: parsedLead.phone,
        source: 'Google Lead Forms',
        sourceType: 'google_ads',
        tags: vertical === 'implant' ? ['google'] : ['google', vertical],
        // Google lead forms carry no standard consent signal → leave UNKNOWN
        // (the shared path never fabricates a false); earned via re-permission.
        utm_source: 'google',
        gclid: (body.gclid as string) || (body.gcl_id as string) || null,
      },
      { caller: 'google-lead-forms', armSpeedToLead: vertical === 'implant' },
    )
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'ingest failed' },
      { status: 500 },
    )
  }

  if (result.deduplicated) {
    return NextResponse.json({ success: true, lead_id: result.id, action: 'duplicate' })
  }

  // Google-specific attribution the shared ingest path doesn't carry.
  await supabase
    .from('leads')
    .update({
      utm_medium: 'cpc',
      utm_campaign: (body.campaign_name as string) || (body.utm_campaign as string) || null,
      city: parsedLead.city,
      zip_code: parsedLead.zip,
      custom_fields: {
        treatment_interest: vertical,
        google_lead_id: body.lead_id ?? body.google_key,
        campaign_id: body.campaign_id,
        ad_group_id: body.adgroup_id ?? body.ad_group_id,
        form_id: body.form_id,
      },
    })
    .eq('id', result.id)

  const leadId = result.id
  after(async () => {
    await result.runPostIngest()
    try {
      const { data: lead } = await supabase.from('leads').select('*').eq('id', leadId).single()
      if (lead) {
        const score = await scoreLead(lead, supabase)
        await supabase
          .from('leads')
          .update({
            ai_score: score.total_score,
            ai_qualification: score.qualification,
            ai_score_breakdown: { dimensions: score.dimensions, confidence: score.confidence },
            ai_score_updated_at: new Date().toISOString(),
            ai_summary: score.summary,
          })
          .eq('id', leadId)

        dispatchConnectorEvent(supabase, {
          type: 'lead.created',
          organizationId: orgId,
          leadId,
          timestamp: new Date().toISOString(),
          data: { lead: buildConnectorLeadData(lead) },
        }).catch(() => {})

        // Staff new-lead alert (email + service-line-routed Slack). Real-time
        // single-lead path (one POST per submission), so it always alerts —
        // no backfill guard needed. Identity comes from the parsed plaintext
        // (the DB row is encrypted); routing/AI come from the enrichment above.
        try {
          const { notifyNewLead } = await import('@/lib/notifications/new-lead-alert')
          await notifyNewLead(supabase, {
            organizationId: orgId,
            lead: {
              id: leadId,
              firstName: parsedLead.firstName || 'Unknown',
              lastName: parsedLead.lastName,
              email: parsedLead.email,
              phone: parsedLead.phone,
              source: 'Google Lead Forms',
              tags: vertical === 'implant' ? ['google'] : ['google', vertical],
              custom_fields: { treatment_interest: vertical },
              utm_source: 'google',
              utm_medium: 'cpc',
              utm_campaign: (body.campaign_name as string) || (body.utm_campaign as string) || null,
              city: parsedLead.city,
              aiQualification: score.qualification,
              aiScore: score.total_score,
              aiSummary: score.summary,
              submittedAt: new Date().toISOString(),
            },
          })
        } catch {
          /* staff alert is best-effort — never blocks ingestion */
        }
      }
    } catch {
      /* scoring/dispatch are best-effort */
    }
  })

  return NextResponse.json({ success: true, lead_id: result.id, action: 'created' }, { status: 201 })
}
