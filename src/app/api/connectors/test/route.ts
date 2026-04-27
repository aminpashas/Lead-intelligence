import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import type { ConnectorType } from '@/lib/connectors'
import { decryptCredentials } from '@/lib/connectors/crypto'

/**
 * POST /api/connectors/test — Send a test event to verify connector configuration.
 *
 * Sends a synthetic "lead.created" event with test data to the specified connector
 * and returns the raw result so the user can verify the connection works.
 */
export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.api)
  if (rlError) return rlError

  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!['owner', 'admin'].includes(profile.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await request.json() as { connector_type: ConnectorType }
  const { connector_type } = body

  if (!connector_type) {
    return NextResponse.json({ error: 'connector_type is required' }, { status: 400 })
  }

  // Fetch the connector config
  const { data: config } = await supabase
    .from('connector_configs')
    .select('*')
    .eq('organization_id', profile.organization_id)
    .eq('connector_type', connector_type)
    .single()

  if (!config) {
    return NextResponse.json({
      error: `Connector "${connector_type}" is not configured. Set it up first in Settings → Connectors.`,
    }, { status: 404 })
  }

  // Credentials are encrypted at rest; decrypt before handing to connector modules.
  const decryptedCredentials = decryptCredentials(config.credentials as Record<string, unknown>)

  // Build a synthetic test event
  const testEvent = {
    type: 'lead.created' as const,
    organizationId: profile.organization_id,
    leadId: '00000000-0000-0000-0000-000000000000',
    timestamp: new Date().toISOString(),
    data: {
      lead: {
        id: '00000000-0000-0000-0000-000000000000',
        firstName: 'Test',
        lastName: 'Lead',
        email: 'test@leadintelligence.ai',
        phone: '+15551234567',
        source_type: 'website_form',
        gclid: null,
        fbclid: null,
        utm_source: 'test',
        utm_medium: 'connector-test',
        utm_campaign: 'verification',
        utm_content: null,
        utm_term: null,
        ai_score: 85,
        ai_qualification: 'hot',
        treatment_value: 25000,
        actual_revenue: null,
        status: 'new',
        stage_slug: 'new',
        city: 'Los Angeles',
        state: 'CA',
        zip_code: '90001',
        created_at: new Date().toISOString(),
        converted_at: null,
      },
      metadata: { test: true, source: 'connector_test_endpoint' },
    },
  }

  // Execute the specific connector
  let result
  try {
    switch (connector_type) {
      case 'google_ads': {
        const { uploadClickConversion } = await import('@/lib/connectors/google-ads/offline-conversions')
        // Orgs connected via OAuth only persist customerId + refreshToken
        // per-org; the platform OAuth client + dev token come from env.
        const gadsCreds = {
          ...(decryptedCredentials as Record<string, unknown>),
          developerToken: (decryptedCredentials as { developerToken?: string }).developerToken
            || process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
          clientId: (decryptedCredentials as { clientId?: string }).clientId
            || process.env.GOOGLE_ADS_CLIENT_ID,
          clientSecret: (decryptedCredentials as { clientSecret?: string }).clientSecret
            || process.env.GOOGLE_ADS_CLIENT_SECRET,
        }
        result = await uploadClickConversion(testEvent, gadsCreds as any)
        break
      }
      case 'meta_capi': {
        const { sendMetaConversionEvent } = await import('@/lib/connectors/meta/capi')
        result = await sendMetaConversionEvent(testEvent, decryptedCredentials as any)
        break
      }
      case 'ga4': {
        const { sendGA4Event } = await import('@/lib/connectors/ga4/measurement')
        // Use debug endpoint for test
        result = await sendGA4Event(testEvent, decryptedCredentials as any, { debug: true })
        break
      }
      case 'outbound_webhook': {
        const { sendOutboundWebhook } = await import('@/lib/connectors/webhooks/outbound')
        result = await sendOutboundWebhook(testEvent, decryptedCredentials as any)
        break
      }
      case 'slack': {
        const { sendSlackNotification } = await import('@/lib/connectors/slack/notify')
        result = await sendSlackNotification(testEvent, decryptedCredentials as any)
        break
      }
      case 'google_reviews': {
        const { processReviewRequest } = await import('@/lib/connectors/google-business/reviews')
        // Use treatment.completed event type for review test
        const reviewTestEvent = { ...testEvent, type: 'treatment.completed' as const }
        result = await processReviewRequest(reviewTestEvent, decryptedCredentials as any)
        break
      }
      default:
        result = { connector: connector_type, success: false, error: 'Unknown connector type' }
    }
  } catch (err) {
    result = {
      connector: connector_type,
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    }
  }

  return NextResponse.json({
    test: true,
    result,
    event: { type: testEvent.type, lead: 'Test Lead (synthetic)' },
  })
}
