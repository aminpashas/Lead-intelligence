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
  getMetaLeadAdsConfig,
  verifyMetaSignature,
  parseMetaLeadFields,
  hasContact,
  fetchMetaLeadFields,
  type MetaFieldDatum,
} from '@/lib/connectors/meta/lead-ads'

// GET /api/webhooks/meta — Meta webhook verification handshake (required for setup)
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const mode = searchParams.get('hub.mode')
  const token = searchParams.get('hub.verify_token')
  const challenge = searchParams.get('hub.challenge')

  // Verify token is per-org when configured, else the shared WEBHOOK_SECRET.
  const orgId = searchParams.get('org')
  let verifyToken = process.env.META_VERIFY_TOKEN?.trim() || process.env.WEBHOOK_SECRET?.trim() || null
  if (orgId && /^[0-9a-f-]{36}$/i.test(orgId)) {
    try {
      const cfg = await getMetaLeadAdsConfig(createServiceClient(), orgId)
      verifyToken = cfg.verifyToken ?? verifyToken
    } catch {
      /* fall back to env token */
    }
  }

  if (mode === 'subscribe' && verifyToken && token === verifyToken) {
    return new NextResponse(challenge, { status: 200 })
  }
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
}

// POST /api/webhooks/meta — Meta Lead Ads leadgen webhook
export async function POST(request: NextRequest) {
  const rlError = await applyDistributedRateLimit(request, RATE_LIMITS.webhook, 'wh-meta')
  if (rlError) return rlError

  const { rawBody, parsed: body } = await getRawBodyAndParsed(request)

  const orgResult = await validateOrgId(new URL(request.url).searchParams.get('org'))
  if (orgResult instanceof NextResponse) return orgResult
  const { orgId } = orgResult

  const supabase = createServiceClient()
  const metaConfig = await getMetaLeadAdsConfig(supabase, orgId)

  // Signature: prefer Meta's real model (HMAC keyed by the App Secret). Fall back
  // to the shared WEBHOOK_SECRET only when no App Secret is configured, so
  // existing signed test/relay traffic keeps working during rollout.
  const sigHeader = request.headers.get('x-hub-signature-256')
  if (metaConfig.appSecret) {
    if (!verifyMetaSignature(rawBody, sigHeader, metaConfig.appSecret)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }
  } else {
    const sigError = verifyWebhookSignature(rawBody, sigHeader, { prefix: 'sha256=' })
    if (sigError) return sigError
  }

  const payload = body as Record<string, unknown>
  const entries = (payload.entry as Array<Record<string, unknown>>) || []

  let created = 0
  let skipped = 0

  for (const entry of entries) {
    const changes = (entry.changes as Array<Record<string, unknown>>) || []
    for (const change of changes) {
      if (change.field !== 'leadgen') continue
      const value = (change.value as Record<string, unknown>) || {}
      const leadgenId = value.leadgen_id as string | undefined

      // Meta's webhook omits the answers. Use inline field_data when a relay
      // (Zapier/Make/test) provides it; otherwise fetch from the Graph API.
      let fieldData = (value.field_data as MetaFieldDatum[] | undefined) ?? null
      let formName = value.form_name as string | undefined
      let adId = value.ad_id as string | undefined
      let formId = value.form_id as string | undefined

      if (!fieldData && leadgenId && metaConfig.pageAccessToken) {
        const fetched = await fetchMetaLeadFields(leadgenId, metaConfig.pageAccessToken)
        if (fetched) {
          fieldData = fetched.field_data
          formName = fetched.form_name ?? fetched.campaign_name ?? formName
          adId = fetched.ad_id ?? adId
          formId = fetched.form_id ?? formId
        }
      }

      // No answers available (no page token AND no inline data) → skip rather than
      // store a blank "Meta Lead". Returning non-200 would make Meta retry/disable
      // the subscription, so we ack but record nothing.
      if (!fieldData) {
        skipped++
        continue
      }

      const parsed = parseMetaLeadFields(fieldData)
      if (!hasContact(parsed)) {
        skipped++
        continue
      }

      let result
      try {
        result = await ingestLead(
          supabase,
          {
            organizationId: orgId,
            firstName: parsed.firstName,
            lastName: parsed.lastName,
            email: parsed.email,
            phoneRaw: parsed.phone,
            source: 'Meta Lead Ads',
            sourceType: 'meta_ads',
            tags: ['meta'],
            consent: {
              sms: parsed.consent.sms,
              email: parsed.consent.email,
              source: 'meta_lead_form',
            },
            utm_source: 'facebook',
            // fbclid is not present on leadgen; CAPI matches on hashed PII + lead_id.
          },
          { caller: 'meta-lead-ads', armSpeedToLead: true },
        )
      } catch {
        skipped++
        continue
      }

      if (result.deduplicated) {
        skipped++
        continue
      }
      created++

      // Meta-specific attribution the shared ingest path doesn't carry.
      await supabase
        .from('leads')
        .update({
          utm_medium: 'paid_social',
          utm_campaign: formName ?? null,
          city: parsed.city,
          zip_code: parsed.zip,
          custom_fields: {
            meta_lead_id: leadgenId,
            meta_form_id: formId,
            meta_page_id: value.page_id,
            meta_ad_id: adId,
          },
        })
        .eq('id', result.id)

      const leadId = result.id
      after(async () => {
        // Post-ingest (financial regex + speed-to-lead), then AI scoring.
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
          }
        } catch {
          /* scoring/dispatch are best-effort */
        }
      })
    }
  }

  return NextResponse.json({ success: true, created, skipped })
}
