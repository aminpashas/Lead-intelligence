import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { getLenderAdapter } from '@/lib/financing/adapters'
import { API_LENDER_SLUGS } from '@/lib/financing/adapters'
import { resumeWaterfall, findApplicationByExternalId } from '@/lib/financing/waterfall-resume'
import { financingWebhookBaseSchema } from '@/lib/validators/financing'
import { auditPHIWrite } from '@/lib/hipaa-audit'
import type { LenderSlug, LenderApplicationResponse } from '@/lib/financing/types'

type RouteParams = { params: Promise<{ lenderSlug: string }> }

const VALID_LENDER_SLUGS: LenderSlug[] = ['carecredit', 'sunbit', 'affirm', 'proceed', 'lendingclub']

/**
 * POST /api/webhooks/financing/[lenderSlug]
 *
 * Webhook endpoint for lender callbacks (CareCredit, Sunbit, Affirm).
 * When a lender returns an async result (after a 'pending' response),
 * this endpoint receives the update and resumes the waterfall.
 *
 * SECURITY (SEC-1):
 * - Signature verification is MANDATORY for API lenders
 * - Unsigned payloads from API lenders are rejected with 401
 * - Application lookup happens AFTER signature verification
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
    const isApiLender = API_LENDER_SLUGS.includes(slug)

    // Read raw body for signature verification
    const rawBody = await request.text()
    let payload: Record<string, unknown>

    try {
      payload = JSON.parse(rawBody)
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const supabase = createServiceClient()

    // ── Signature Verification (MANDATORY for API lenders) ──────────
    // SEC-1: API lenders MUST have verifyWebhook. Reject unsigned payloads.
    if (isApiLender) {
      if (!adapter.verifyWebhook) {
        console.error(`[webhook/${slug}] CRITICAL: API lender adapter missing verifyWebhook implementation`)
        return NextResponse.json({ error: 'Webhook verification not configured' }, { status: 500 })
      }

      const signature = request.headers.get('x-webhook-signature')
        || request.headers.get('x-signature')
        || request.headers.get('x-hub-signature-256')
        || ''

      if (!signature) {
        return NextResponse.json({ error: 'Missing webhook signature' }, { status: 401 })
      }

      // Extract external ID to find the org's webhook secret
      const sigCheckExternalId = (payload.external_application_id || payload.application_id
        || payload.transaction_id || (payload.data as Record<string, unknown>)?.checkout_token
        || (payload.data as Record<string, unknown>)?.id) as string

      if (!sigCheckExternalId) {
        return NextResponse.json({ error: 'Missing application identifier' }, { status: 400 })
      }

      const sigAppRef = await findApplicationByExternalId(supabase, slug, sigCheckExternalId)
      if (!sigAppRef) {
        // Don't reveal whether the ID exists — use generic error
        return NextResponse.json({ error: 'Webhook verification failed' }, { status: 401 })
      }

      // Load the lender config to get webhook secret
      const { data: lenderConfig } = await supabase
        .from('financing_lender_configs')
        .select('config')
        .eq('organization_id', sigAppRef.organizationId)
        .eq('lender_slug', slug)
        .single()

      const webhookSecret = (lenderConfig?.config as Record<string, string>)?.webhook_secret || ''
      if (!webhookSecret) {
        console.error(`[webhook/${slug}] No webhook_secret configured for org ${sigAppRef.organizationId}`)
        return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 })
      }

      if (!adapter.verifyWebhook(signature, rawBody, webhookSecret)) {
        console.warn(`[webhook/${slug}] Signature verification failed for external ID: ${sigCheckExternalId}`)
        return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 })
      }
    }

    // ── Affirm-specific payload normalization ──────────────────────
    // Affirm sends: { event_type: 'charge.confirmed', data: { checkout_token, id, amount } }
    // Amount is in cents; map to our standard shape before continuing.
    if (slug === 'affirm') {
      const affirmEvent = payload.event_type as string | undefined
      const affirmData = payload.data as Record<string, unknown> | undefined

      const checkoutToken = (affirmData?.checkout_token || payload.checkout_token) as string | undefined
      const chargeId = (affirmData?.id || payload.id) as string | undefined
      const amountCents = (affirmData?.amount || payload.amount) as number | undefined
      const approvedAmount = amountCents ? amountCents / 100 : undefined

      const externalIdForLookup = checkoutToken || chargeId
      if (!externalIdForLookup) {
        return NextResponse.json({ error: 'Missing Affirm charge identifier' }, { status: 400 })
      }

      const affirmAppRef = await findApplicationByExternalId(supabase, slug, externalIdForLookup)
      if (!affirmAppRef) {
        console.warn(`[webhook/affirm] No application found for token: ${externalIdForLookup}`)
        return NextResponse.json({ received: true, matched: false })
      }

      await auditPHIWrite(
        { supabase, organizationId: affirmAppRef.organizationId, actorType: 'webhook' },
        'financing_submission',
        affirmAppRef.applicationId,
        `Affirm webhook received: event=${affirmEvent}`,
        ['financial']
      )

      let affirmStatus: LenderApplicationResponse['status']
      if (affirmEvent === 'charge.confirmed' || affirmEvent === 'charge.captured' || affirmEvent === 'charge.authorized') {
        affirmStatus = 'approved'
      } else if (affirmEvent === 'charge.void' || affirmEvent === 'charge.failed' || affirmEvent === 'charge.declined') {
        affirmStatus = 'denied'
      } else {
        return NextResponse.json({ received: true, matched: true, action: 'ignored', event: affirmEvent })
      }

      const affirmResponse: LenderApplicationResponse = {
        status: affirmStatus,
        external_id: chargeId || externalIdForLookup,
        approved_amount: affirmStatus === 'approved' ? approvedAmount : undefined,
        denial_reason_code: affirmStatus === 'denied' ? (affirmEvent || 'declined') : undefined,
      }

      const affirmResult = await resumeWaterfall(
        affirmAppRef.applicationId,
        slug,
        affirmResponse,
        supabase
      )

      return NextResponse.json({ received: true, matched: true, result: affirmResult })
    }

    // ── Standard lender flow (CareCredit, Sunbit) ──────────────────
    const validation = financingWebhookBaseSchema.safeParse(payload)
    if (!validation.success) {
      console.error(`[webhook/${slug}] Invalid payload:`, validation.error.flatten())
      return NextResponse.json(
        { error: 'Invalid webhook payload', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const webhookData = validation.data
    const externalId = webhookData.external_application_id
    const appRef = await findApplicationByExternalId(supabase, slug, externalId)

    if (!appRef) {
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

    const lenderResponse: LenderApplicationResponse = {
      status: webhookData.status,
      external_id: externalId,
      approved_amount: webhookData.approved_amount,
      terms: webhookData.terms,
      denial_reason_code: webhookData.denial_reason_code,
      error_message: webhookData.error_message,
    }

    const result = await resumeWaterfall(
      appRef.applicationId,
      slug,
      lenderResponse,
      supabase
    )

    return NextResponse.json({ received: true, matched: true, result })
  } catch (error) {
    console.error(`[webhook/financing] Error:`, error instanceof Error ? error.message : 'Unknown')
    // Always return 200 to prevent lender retry loops on our errors
    return NextResponse.json({ received: true, error: 'Internal processing error' }, { status: 200 })
  }
}
