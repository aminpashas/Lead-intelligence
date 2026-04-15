import { NextRequest, NextResponse, after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/server'
import { financingApplicationSchema, publicFinancingApplicationSchema } from '@/lib/validators/financing'
import { encryptApplicantData, hashSSN } from '@/lib/financing/encryption-helpers'
import { executeWaterfall } from '@/lib/financing/waterfall'
import { auditPHIWrite } from '@/lib/hipaa-audit'
import { buildOptimalWaterfallOrder, describeWaterfallStrategy } from '@/lib/financing/lender-profiles'
import type { ApplicantData, WaterfallConfig, LenderSlug } from '@/lib/financing/types'
import type { CreditTier } from '@/lib/enrichment/credit-prequal'
import { checkRateLimit, FINANCING_APPLY_RATE_LIMIT, FINANCING_TOKEN_RATE_LIMIT } from '@/lib/financing/rate-limiter'

/**
 * POST /api/financing/apply
 *
 * Start a financing application and execute the waterfall.
 * Supports two flows:
 * 1. Staff-initiated: requires auth + lead_id
 * 2. Public form: requires share_token (from /finance/[shareToken] page)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const shareToken = request.headers.get('x-share-token')

    // SEC-5: Rate limit by IP — prevent mass credit pull attacks
    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || request.headers.get('x-real-ip')
      || 'unknown'
    const ipLimit = checkRateLimit(`financing:ip:${clientIp}`, FINANCING_APPLY_RATE_LIMIT)
    if (!ipLimit.allowed) {
      return NextResponse.json(
        { error: 'Too many financing requests. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((ipLimit.resetAt - Date.now()) / 1000)) } }
      )
    }

    // SEC-5: Rate limit by share token — 1 submission per token
    if (shareToken) {
      const tokenLimit = checkRateLimit(`financing:token:${shareToken}`, FINANCING_TOKEN_RATE_LIMIT)
      if (!tokenLimit.allowed) {
        return NextResponse.json(
          { error: 'An application has already been submitted with this link.' },
          { status: 429 }
        )
      }
    }

    let organizationId: string
    let leadId: string

    if (shareToken) {
      // ── Public form flow ──
      const validation = publicFinancingApplicationSchema.safeParse(body)
      if (!validation.success) {
        return NextResponse.json(
          { error: 'Validation failed', details: validation.error.flatten().fieldErrors },
          { status: 400 }
        )
      }

      // Look up the share token to find org + lead
      const serviceClient = createServiceClient()
      const { data: tokenData } = await serviceClient
        .from('financing_applications')
        .select('id, organization_id, lead_id, status, expires_at')
        .eq('share_token', shareToken)
        .single()

      if (!tokenData) {
        return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 })
      }

      if (new Date(tokenData.expires_at) < new Date()) {
        return NextResponse.json({ error: 'This financing link has expired' }, { status: 410 })
      }

      if (tokenData.status !== 'pending') {
        return NextResponse.json(
          { error: 'An application has already been submitted with this link' },
          { status: 409 }
        )
      }

      organizationId = tokenData.organization_id
      leadId = tokenData.lead_id

      // Update the existing application with form data
      const applicantData: ApplicantData = {
        first_name: validation.data.first_name,
        last_name: validation.data.last_name,
        date_of_birth: validation.data.date_of_birth,
        ssn: validation.data.ssn,
        email: validation.data.email,
        phone: validation.data.phone,
        address: {
          street: validation.data.street_address,
          city: validation.data.city,
          state: validation.data.state,
          zip: validation.data.zip_code,
        },
        annual_income: validation.data.annual_income,
        employment_status: validation.data.employment_status,
        employer_name: validation.data.employer_name,
      }

      const encrypted = encryptApplicantData(applicantData)
      const ssnHash = hashSSN(validation.data.ssn)

      await serviceClient
        .from('financing_applications')
        .update({
          applicant_data_encrypted: encrypted,
          applicant_ssn_hash: ssnHash,
          requested_amount: validation.data.requested_amount,
          consent_given_at: new Date().toISOString(),
          consent_ip_address: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', tokenData.id)

      // Audit log — AUTH-5: use correct actor type for patient-initiated submissions
      await auditPHIWrite(
        { supabase: serviceClient, organizationId, actorType: 'system' },
        'financing_application',
        tokenData.id,
        'Financing application submitted by patient via public form',
        ['ssn', 'financial', 'name', 'dob', 'address', 'phone', 'email']
      )

      // PROD-2: Execute waterfall asynchronously — don't block the patient's response.
      // The waterfall iterates through lenders (potentially 30-60s), so we return
      // immediately and run it in the background via next/server after().
      after(async () => {
        try {
          await executeWaterfall(tokenData.id, serviceClient, organizationId)
        } catch (err) {
          console.error('[financing/apply] Background waterfall error:', err instanceof Error ? err.message : err)
        }
      })

      return NextResponse.json({
        success: true,
        application_id: tokenData.id,
        status: 'processing',
        message: 'Your application is being reviewed. You will receive a notification with the result.',
      })
    }

    // ── Staff-initiated flow ──
    const validation = financingApplicationSchema.safeParse(body)
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Get user's org
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('organization_id')
      .eq('id', user.id)
      .single()

    if (!profile) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 403 })
    }

    organizationId = profile.organization_id
    leadId = validation.data.lead_id

    // Verify lead belongs to org
    const { data: lead } = await supabase
      .from('leads')
      .select('id')
      .eq('id', leadId)
      .eq('organization_id', organizationId)
      .single()

    if (!lead) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
    }

    // Check for existing active application (dedup by SSN hash)
    const ssnHash = hashSSN(validation.data.ssn)
    if (ssnHash) {
      const { data: existing } = await supabase
        .from('financing_applications')
        .select('id, status')
        .eq('organization_id', organizationId)
        .eq('applicant_ssn_hash', ssnHash)
        .in('status', ['pending', 'in_progress'])
        .limit(1)
        .single()

      if (existing) {
        return NextResponse.json(
          { error: 'An active application already exists for this applicant', application_id: existing.id },
          { status: 409 }
        )
      }
    }

    // Build applicant data
    const applicantData: ApplicantData = {
      first_name: validation.data.first_name,
      last_name: validation.data.last_name,
      date_of_birth: validation.data.date_of_birth,
      ssn: validation.data.ssn,
      email: validation.data.email,
      phone: validation.data.phone,
      address: {
        street: validation.data.street_address,
        city: validation.data.city,
        state: validation.data.state,
        zip: validation.data.zip_code,
      },
      annual_income: validation.data.annual_income,
      employment_status: validation.data.employment_status,
      employer_name: validation.data.employer_name,
    }

    const encrypted = encryptApplicantData(applicantData)

    // Load active lenders to build waterfall config
    const { data: lenderConfigs } = await supabase
      .from('financing_lender_configs')
      .select('lender_slug, priority_order, integration_type')
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .order('priority_order', { ascending: true })

    if (!lenderConfigs || lenderConfigs.length === 0) {
      return NextResponse.json(
        { error: 'No financing lenders are configured. Please set up lenders in Settings.' },
        { status: 422 }
      )
    }

    // Fetch the lead's estimated credit tier from enrichment data
    // to build a credit-optimized waterfall order
    const { data: leadEnrichment } = await supabase
      .from('leads')
      .select('credit_tier, financing_readiness_score')
      .eq('id', leadId)
      .single()

    const creditTier = (leadEnrichment?.credit_tier as CreditTier | null) || 'unknown'
    const activeSlugs = lenderConfigs.map(lc => lc.lender_slug as LenderSlug)

    // Build credit-aware ordering: highest approval-likelihood lenders first
    const optimizedOrder = buildOptimalWaterfallOrder(activeSlugs, creditTier)
    const strategyDescription = describeWaterfallStrategy(optimizedOrder, creditTier)

    // Fall back to manual priority_order if optimization produces no results
    const finalOrder = optimizedOrder.length > 0 ? optimizedOrder : activeSlugs

    const waterfallConfig: WaterfallConfig = {
      lenders: finalOrder.map((slug, idx) => {
        const config = lenderConfigs.find(lc => lc.lender_slug === slug)!
        return {
          slug,
          priority: idx + 1,
          integration_type: config.integration_type,
        }
      }),
    }

    // Create application
    const { data: application, error: insertError } = await supabase
      .from('financing_applications')
      .insert({
        organization_id: organizationId,
        lead_id: leadId,
        status: 'pending',
        applicant_data_encrypted: encrypted,
        applicant_ssn_hash: ssnHash,
        requested_amount: validation.data.requested_amount,
        waterfall_config: waterfallConfig,
        consent_given_at: new Date().toISOString(),
        consent_ip_address: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || null,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h TTL
      })
      .select('id')
      .single()

    if (insertError || !application) {
      return NextResponse.json({ error: 'Failed to create application' }, { status: 500 })
    }

    // Update lead with application reference
    await supabase
      .from('leads')
      .update({ financing_application_id: application.id })
      .eq('id', leadId)

    // Audit log
    await auditPHIWrite(
      { supabase, organizationId, actorId: user.id, actorType: 'user' },
      'financing_application',
      application.id,
      `Financing application created by staff for lead ${leadId}`,
      ['ssn', 'financial', 'name', 'dob', 'address', 'phone', 'email']
    )

    // Log activity — include credit tier and waterfall strategy for transparency
    try {
      await supabase
        .from('lead_activities')
        .insert({
          organization_id: organizationId,
          lead_id: leadId,
          user_id: user.id,
          activity_type: 'financing_submitted',
          title: 'Financing application submitted',
          description: `Requested: $${validation.data.requested_amount.toLocaleString()} · Credit tier: ${creditTier} · ${strategyDescription}`,
          metadata: {
            application_id: application.id,
            requested_amount: validation.data.requested_amount,
            credit_tier: creditTier,
            waterfall_strategy: strategyDescription,
            lender_order: finalOrder,
            lender_count: finalOrder.length,
          },
        })
    } catch { /* Non-blocking */ }

    // PROD-2: Execute waterfall asynchronously via after().
    // The waterfall can take 30-60s iterating through lenders — don't block the staff UI.
    // The result will be reflected in the application record and activity log.
    const serviceClient = createServiceClient()
    after(async () => {
      try {
        await executeWaterfall(application.id, serviceClient, organizationId)
      } catch (err) {
        console.error('[financing/apply] Background waterfall error:', err instanceof Error ? err.message : err)
        // Mark application as error so it's not stuck in pending forever
        await serviceClient
          .from('financing_applications')
          .update({ status: 'error', updated_at: new Date().toISOString() })
          .eq('id', application.id)
      }
    })

    return NextResponse.json({
      success: true,
      application_id: application.id,
      status: 'processing',
      message: 'Application submitted. The waterfall is running — results will appear in the lead timeline.',
    })
  } catch (error) {
    console.error('[financing/apply] Error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
