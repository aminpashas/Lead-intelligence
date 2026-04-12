import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/server'
import { auditPHIRead } from '@/lib/hipaa-audit'
import { maskSSN } from '@/lib/financing/encryption-helpers'
import type { FinancingApplication, FinancingSubmission } from '@/lib/financing/types'

type RouteParams = { params: Promise<{ applicationId: string }> }

/**
 * GET /api/financing/[applicationId]
 *
 * Get financing application status, waterfall progress, and submission history.
 * Supports both authenticated staff access and public access via share token.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { applicationId } = await params
    const shareToken = request.headers.get('x-share-token')

    let application: FinancingApplication | null = null
    let submissions: FinancingSubmission[] = []
    let organizationId: string

    if (shareToken) {
      // ── Public access via share token ──
      const serviceClient = createServiceClient()
      const { data } = await serviceClient
        .from('financing_applications')
        .select('*')
        .eq('id', applicationId)
        .eq('share_token', shareToken)
        .single()

      if (!data) {
        return NextResponse.json({ error: 'Application not found' }, { status: 404 })
      }

      application = data as FinancingApplication
      organizationId = application.organization_id

      // Load submissions (limited data for public view)
      const { data: subs } = await serviceClient
        .from('financing_submissions')
        .select('lender_slug, waterfall_step, status, application_url, responded_at')
        .eq('application_id', applicationId)
        .order('waterfall_step', { ascending: true })

      submissions = (subs || []) as FinancingSubmission[]
    } else {
      // ── Authenticated staff access ──
      const supabase = await createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const { data: profile } = await supabase
        .from('user_profiles')
        .select('organization_id')
        .eq('id', user.id)
        .single()

      if (!profile) {
        return NextResponse.json({ error: 'User profile not found' }, { status: 403 })
      }

      const { data } = await supabase
        .from('financing_applications')
        .select('*')
        .eq('id', applicationId)
        .eq('organization_id', profile.organization_id)
        .single()

      if (!data) {
        return NextResponse.json({ error: 'Application not found' }, { status: 404 })
      }

      application = data as FinancingApplication
      organizationId = application.organization_id

      // Load full submission history
      const { data: subs } = await supabase
        .from('financing_submissions')
        .select('*')
        .eq('application_id', applicationId)
        .order('waterfall_step', { ascending: true })

      submissions = (subs || []) as FinancingSubmission[]

      // Audit log
      await auditPHIRead(
        { supabase, organizationId, actorId: user.id, actorType: 'user' },
        'financing_application',
        applicationId,
        `Staff viewed financing application ${applicationId}`,
        ['financial']
      )
    }

    // Build response (never expose encrypted data or full SSN)
    const response = {
      id: application.id,
      lead_id: application.lead_id,
      status: application.status,
      requested_amount: application.requested_amount,
      approved_lender_slug: application.approved_lender_slug,
      approved_amount: application.approved_amount,
      approved_terms: application.approved_terms,
      current_waterfall_step: application.current_waterfall_step,
      waterfall_config: application.waterfall_config,
      expires_at: application.expires_at,
      completed_at: application.completed_at,
      created_at: application.created_at,
      updated_at: application.updated_at,
      // SSN is masked — never returned in full
      ssn_last_four: application.applicant_ssn_hash ? '****' : null,
      submissions: submissions.map(sub => ({
        lender_slug: sub.lender_slug,
        waterfall_step: sub.waterfall_step,
        status: sub.status,
        application_url: sub.application_url,
        response_data: sub.response_data,
        submitted_at: sub.submitted_at,
        responded_at: sub.responded_at,
      })),
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error('[financing/applicationId] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
