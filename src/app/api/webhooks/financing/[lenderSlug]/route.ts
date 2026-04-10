import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { getLenderAdapter } from '@/lib/financing/adapters'
import { resumeWaterfall, findApplicationByExternalId } from '@/lib/financing/waterfall-resume'
import { financingWebhookBaseSchema } from '@/lib/validators/financing'
import { auditPHIWrite } from '@/lib/hipaa-audit'
import type { LenderSlug, LenderApplicationResponse } from '@/lib/financing/types'

type RouteParams = { params: Promise<{ lenderSlug: string }> }

const VALID_LENDER_SLUGS: LenderSlug[] = ['carecredit', 'sunbit', 'proceed', 'lendingclub']

/**
 * POST /api/webhooks/financing/[lenderSlug]
 *
 * Webhook endpoint for lender callbacks (CareCredit, Sunbit).
 * When a lender returns an async result (after a 'pending' response),
 * this endpoint receives the update and resumes the waterfall.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { lenderSlug } = await params

    // Validate lender slug
    if (!VALID_LENDER_SLUGS.includes(lenderSlug as LenderSlug)) {
      return NextResponse.json({ error: 'Unknown lender' }, { status: 404 })
    }

    const slug = lenderSlug as LenderSlug
    const adapter = getLenderAdapter(slug)

    // Read raw body for signature verification
    const rawBody = await request.text()
    let payload: Record<string, unknown>

    try {
      payload = JSON.parse(rawBody)
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    // Verify webhook signature if the adapter supports it
    if (adapter.verifyWebhook) {
      const signature = request.headers.get('x-webhook-signature')
        || request.headers.get('x-signature')
        || request.headers.get('x-hub-signature-256')
        || ''

      const supabase = createServiceClient()

      // Find the org's webhook secret from lender config
      // We need the external_application_id to look up the org
      const externalId = (payload.external_application_id || payload.application_id || payload.transaction_id) as string
      if (!externalId) {
        return NextResponse.json({ error: 'Missing application identifier' }, { status: 400 })
      }

      const appRef = await findApplicationByExternalId(supabase, slug, externalId)
      if (!appRef) {
        return NextResponse.json({ error: 'Application not found' }, { status: 404 })
      }

      // Load the lender config to get webhook secret
      const { data: lenderConfig } = await supabase
        .from('financing_lender_configs')
        .select('config')
        .eq('organization_id', appRef.organizationId)
        .eq('lender_slug', slug)
        .single()

      const webhookSecret = (lenderConfig?.config as Record<string, string>)?.webhook_secret || ''

      if (!adapter.verifyWebhook(signature, rawBody, webhookSecret)) {
        return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 })
      }
    }

    // Parse and validate the webhook payload
    const validation = financingWebhookBaseSchema.safeParse(payload)
    if (!validation.success) {
      console.error(`[webhook/${slug}] Invalid payload:`, validation.error.flatten())
      return NextResponse.json(
        { error: 'Invalid webhook payload', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const webhookData = validation.data
    const supabase = createServiceClient()

    // Find the application by external ID
    const externalId = webhookData.external_application_id
    const appRef = await findApplicationByExternalId(supabase, slug, externalId)

    if (!appRef) {
      // Could be a webhook for an app not in our system — ack but ignore
      console.warn(`[webhook/${slug}] No application found for external ID: ${externalId}`)
      return NextResponse.json({ received: true, matched: false })
    }

    // Audit log the incoming webhook
    await auditPHIWrite(
      { supabase, organizationId: appRef.organizationId, actorType: 'webhook' },
      'financing_submission',
      appRef.applicationId,
      `Webhook received from ${slug}: status=${webhookData.status}`,
      ['financial']
    )

    // Build lender response
    const lenderResponse: LenderApplicationResponse = {
      status: webhookData.status,
      external_id: externalId,
      approved_amount: webhookData.approved_amount,
      terms: webhookData.terms,
      denial_reason_code: webhookData.denial_reason_code,
      error_message: webhookData.error_message,
    }

    // Resume the waterfall
    const result = await resumeWaterfall(
      appRef.applicationId,
      slug,
      lenderResponse,
      supabase
    )

    return NextResponse.json({ received: true, matched: true, result })
  } catch (error) {
    console.error(`[webhook/financing] Error:`, error)
    // Always return 200 to prevent lender retry loops on our errors
    return NextResponse.json({ received: true, error: 'Internal processing error' }, { status: 200 })
  }
}
