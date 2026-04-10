import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/server'
import { financingApplicationSchema, publicFinancingApplicationSchema } from '@/lib/validators/financing'
import { encryptApplicantData, hashSSN } from '@/lib/financing/encryption-helpers'
import { executeWaterfall } from '@/lib/financing/waterfall'
import { auditPHIWrite } from '@/lib/hipaa-audit'
import type { ApplicantData, WaterfallConfig, LenderSlug } from '@/lib/financing/types'

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

      // Audit log
      await auditPHIWrite(
        { supabase: serviceClient, organizationId, actorType: 'webhook' },
        'financing_application',
        tokenData.id,
        'Financing application submitted via public form',
        ['ssn', 'financial', 'name', 'dob', 'address', 'phone', 'email']
      )

      // Execute waterfall
      const result = await executeWaterfall(tokenData.id, serviceClient, organizationId)

      return NextResponse.json({ success: true, result })
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

    const waterfallConfig: WaterfallConfig = {
      lenders: lenderConfigs.map((lc, idx) => ({
        slug: lc.lender_slug as LenderSlug,
        priority: idx + 1,
        integration_type: lc.integration_type,
      })),
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

    // Log activity
    try {
      await supabase
        .from('lead_activities')
        .insert({
          organization_id: organizationId,
          lead_id: leadId,
          user_id: user.id,
          activity_type: 'financing_submitted',
          title: 'Financing application submitted',
          description: `Requested amount: $${validation.data.requested_amount.toLocaleString()}`,
          metadata: {
            application_id: application.id,
            requested_amount: validation.data.requested_amount,
            lender_count: lenderConfigs.length,
          },
        })
    } catch { /* Non-blocking */ }

    // Execute waterfall (uses service client for cross-table access)
    const serviceClient = createServiceClient()
    const result = await executeWaterfall(application.id, serviceClient, organizationId)

    return NextResponse.json({ success: true, application_id: application.id, result })
  } catch (error) {
    console.error('[financing/apply] Error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
