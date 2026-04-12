import type { SupabaseClient } from '@supabase/supabase-js'
import { getLenderAdapter } from './adapters'
import { decryptApplicantData, decryptCredentials, FINANCING_PHI_CATEGORIES } from './encryption-helpers'
import { auditPHITransmission } from '@/lib/hipaa-audit'
import { followUpApproved, followUpDenied, followUpPending } from './follow-up'
import type {
  FinancingApplication,
  FinancingLenderConfig,
  LenderApplicationRequest,
  LenderApplicationResponse,
  LenderSlug,
} from './types'

export type WaterfallResult = {
  application_id: string
  status: FinancingApplication['status']
  approved_lender?: LenderSlug
  approved_amount?: number
  current_step: number
  total_steps: number
}

/**
 * Execute the financing waterfall for an application.
 *
 * Iterates through lenders in priority order:
 * - API lenders: submits application, handles approve/deny/pending
 * - Link lenders: generates application URL, sends via SMS, continues
 *
 * Stops on first approval. On denial, moves to next lender.
 * On pending (async), saves state and returns — webhook will resume.
 */
export async function executeWaterfall(
  applicationId: string,
  supabase: SupabaseClient,
  organizationId: string
): Promise<WaterfallResult> {
  // 1. Load the application
  const { data: application, error: appError } = await supabase
    .from('financing_applications')
    .select('*')
    .eq('id', applicationId)
    .eq('organization_id', organizationId)
    .single()

  if (appError || !application) {
    throw new Error(`Application not found: ${applicationId}`)
  }

  // Check if already completed
  if (application.status === 'approved' || application.status === 'denied' || application.status === 'expired') {
    return {
      application_id: applicationId,
      status: application.status,
      approved_lender: application.approved_lender_slug || undefined,
      approved_amount: application.approved_amount || undefined,
      current_step: application.current_waterfall_step,
      total_steps: application.waterfall_config.lenders.length,
    }
  }

  // Check expiry
  if (new Date(application.expires_at) < new Date()) {
    await supabase
      .from('financing_applications')
      .update({ status: 'expired', updated_at: new Date().toISOString() })
      .eq('id', applicationId)

    return {
      application_id: applicationId,
      status: 'expired',
      current_step: application.current_waterfall_step,
      total_steps: application.waterfall_config.lenders.length,
    }
  }

  // 2. Decrypt applicant data
  const applicantData = decryptApplicantData(application.applicant_data_encrypted)

  // 3. Mark as in_progress
  await supabase
    .from('financing_applications')
    .update({ status: 'in_progress', updated_at: new Date().toISOString() })
    .eq('id', applicationId)

  // 4. Iterate through lenders starting from current step
  const lenders = application.waterfall_config.lenders as Array<{
    slug: LenderSlug
    priority: number
    integration_type: string
  }>
  const totalSteps = lenders.length

  for (let step = application.current_waterfall_step; step < totalSteps; step++) {
    const lenderEntry = lenders[step]
    const adapter = getLenderAdapter(lenderEntry.slug)

    // Load lender config
    const { data: lenderConfig } = await supabase
      .from('financing_lender_configs')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('lender_slug', lenderEntry.slug)
      .eq('is_active', true)
      .single()

    if (!lenderConfig) {
      // Lender not active — skip
      await updateWaterfallStep(supabase, applicationId, step + 1)
      continue
    }

    // Create submission record
    const { data: submission } = await supabase
      .from('financing_submissions')
      .insert({
        organization_id: organizationId,
        application_id: applicationId,
        lead_id: application.lead_id,
        lender_slug: lenderEntry.slug,
        waterfall_step: step,
        status: 'submitted',
        submitted_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    const submissionId = submission?.id

    // ── API-based lenders (CareCredit, Sunbit) ──
    if (adapter.submitApplication && lenderConfig.credentials_encrypted) {
      try {
        const credentials = decryptCredentials(lenderConfig.credentials_encrypted)

        // HIPAA audit: log PHI transmission to lender
        auditPHITransmission(
          { supabase, organizationId, actorType: 'system' },
          'financing_submission',
          applicationId,
          adapter.displayName,
          [...FINANCING_PHI_CATEGORIES]
        )

        const request: LenderApplicationRequest = {
          applicant: applicantData,
          requested_amount: application.requested_amount || 0,
          treatment_type: 'dental_implants',
          merchant_id: (lenderConfig.config as Record<string, string>)?.merchant_id,
        }

        const response: LenderApplicationResponse = await adapter.submitApplication(request, credentials)

        // Update submission with response
        if (submissionId) {
          await supabase
            .from('financing_submissions')
            .update({
              status: response.status,
              external_application_id: response.external_id,
              response_data: {
                approved_amount: response.approved_amount,
                terms: response.terms,
                denial_reason_code: response.denial_reason_code,
              },
              responded_at: new Date().toISOString(),
            })
            .eq('id', submissionId)
        }

        // Handle response
        if (response.status === 'approved') {
          const result = await handleApproval(supabase, applicationId, application.lead_id, lenderEntry.slug, response, step, totalSteps)

          // Auto follow-up: notify patient of approval
          followUpApproved(
            { supabase, leadId: application.lead_id, organizationId },
            response.approved_amount || application.requested_amount || 0,
            response.terms?.monthly_payment || 0,
            adapter.displayName
          ).catch((err: unknown) => console.warn('[waterfall] Follow-up approved failed:', err instanceof Error ? err.message : err))

          return result
        }

        if (response.status === 'pending') {
          // Async lender — save state and return. Webhook will resume.
          await updateWaterfallStep(supabase, applicationId, step)

          // Auto follow-up: let patient know it's being reviewed
          followUpPending(
            { supabase, leadId: application.lead_id, organizationId },
            adapter.displayName
          ).catch((err: unknown) => console.warn('[waterfall] Follow-up pending failed:', err instanceof Error ? err.message : err))

          return {
            application_id: applicationId,
            status: 'in_progress',
            current_step: step,
            total_steps: totalSteps,
          }
        }

        // Denied or error — log activity and continue to next lender
        await logFinancingActivity(supabase, organizationId, application.lead_id, 'financing_lender_denied', {
          lender: adapter.displayName,
          reason: response.denial_reason_code || response.error_message,
          step,
        })

      } catch (error) {
        // API error — update submission and continue
        if (submissionId) {
          await supabase
            .from('financing_submissions')
            .update({
              status: 'error',
              error_message: error instanceof Error ? error.message : 'Unknown error',
              responded_at: new Date().toISOString(),
            })
            .eq('id', submissionId)
        }
      }
    }

    // ── Link-based lenders (Proceed, LendingClub) ──
    else if (adapter.generateApplicationUrl) {
      const leadBasicInfo = {
        first_name: applicantData.first_name,
        last_name: applicantData.last_name,
        email: applicantData.email,
        phone: applicantData.phone,
      }

      const applicationUrl = adapter.generateApplicationUrl(leadBasicInfo, lenderConfig.config)

      if (submissionId) {
        await supabase
          .from('financing_submissions')
          .update({
            status: 'link_sent',
            application_url: applicationUrl,
            responded_at: new Date().toISOString(),
          })
          .eq('id', submissionId)
      }

      // Log activity
      await logFinancingActivity(supabase, organizationId, application.lead_id, 'financing_link_sent', {
        lender: adapter.displayName,
        url: applicationUrl,
        step,
      })

      // Don't block waterfall on link-based lenders — continue
    }

    // Update step
    await updateWaterfallStep(supabase, applicationId, step + 1)
  }

  // All lenders exhausted with no approval
  await supabase
    .from('financing_applications')
    .update({
      status: 'denied',
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', applicationId)

  // Update lead
  await supabase
    .from('leads')
    .update({ financing_approved: false })
    .eq('id', application.lead_id)

  await logFinancingActivity(supabase, organizationId, application.lead_id, 'financing_denied', {
    message: 'All lenders exhausted — no approval received',
    total_lenders_tried: totalSteps,
  })

  // Auto follow-up: offer alternative options to patient
  followUpDenied(
    { supabase, leadId: application.lead_id, organizationId }
  ).catch((err: unknown) => console.warn('[waterfall] Follow-up denied failed:', err instanceof Error ? err.message : err))

  return {
    application_id: applicationId,
    status: 'denied',
    current_step: totalSteps,
    total_steps: totalSteps,
  }
}

// ── Helper Functions ────────────────────────────────────────────

async function handleApproval(
  supabase: SupabaseClient,
  applicationId: string,
  leadId: string,
  lenderSlug: LenderSlug,
  response: LenderApplicationResponse,
  step: number,
  totalSteps: number
): Promise<WaterfallResult> {
  // Update application
  await supabase
    .from('financing_applications')
    .update({
      status: 'approved',
      approved_lender_slug: lenderSlug,
      approved_amount: response.approved_amount || null,
      approved_terms: response.terms || null,
      current_waterfall_step: step,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', applicationId)

  // Update lead
  await supabase
    .from('leads')
    .update({
      financing_approved: true,
      financing_amount: response.approved_amount || null,
      financing_application_id: applicationId,
    })
    .eq('id', leadId)

  // Get org for activity logging
  const { data: app } = await supabase
    .from('financing_applications')
    .select('organization_id')
    .eq('id', applicationId)
    .single()

  if (app) {
    await logFinancingActivity(supabase, app.organization_id, leadId, 'financing_approved', {
      lender: lenderSlug,
      approved_amount: response.approved_amount,
      terms: response.terms,
      step,
    })
  }

  return {
    application_id: applicationId,
    status: 'approved',
    approved_lender: lenderSlug,
    approved_amount: response.approved_amount,
    current_step: step,
    total_steps: totalSteps,
  }
}

async function updateWaterfallStep(
  supabase: SupabaseClient,
  applicationId: string,
  step: number
): Promise<void> {
  await supabase
    .from('financing_applications')
    .update({
      current_waterfall_step: step,
      updated_at: new Date().toISOString(),
    })
    .eq('id', applicationId)
}

async function logFinancingActivity(
  supabase: SupabaseClient,
  organizationId: string,
  leadId: string,
  activityType: string,
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    await supabase
      .from('lead_activities')
      .insert({
        organization_id: organizationId,
        lead_id: leadId,
        activity_type: activityType,
        title: getActivityTitle(activityType, metadata),
        description: getActivityDescription(activityType, metadata),
        metadata,
      })
  } catch (err) { console.warn('[waterfall] Activity logging failed:', err instanceof Error ? err.message : (err as string)) }
}

function getActivityTitle(type: string, meta: Record<string, unknown>): string {
  const lender = meta.lender as string || 'Unknown'
  switch (type) {
    case 'financing_approved': return `Financing approved by ${lender}`
    case 'financing_lender_denied': return `Financing denied by ${lender}`
    case 'financing_denied': return 'Financing denied by all lenders'
    case 'financing_link_sent': return `${lender} application link sent`
    case 'financing_submitted': return 'Financing application submitted'
    default: return 'Financing activity'
  }
}

function getActivityDescription(type: string, meta: Record<string, unknown>): string {
  switch (type) {
    case 'financing_approved': {
      const amount = meta.approved_amount as number
      return amount ? `Approved for $${amount.toLocaleString()}` : 'Application approved'
    }
    case 'financing_lender_denied':
      return meta.reason ? `Reason: ${meta.reason}` : 'Application denied'
    case 'financing_denied':
      return `Tried ${meta.total_lenders_tried} lenders with no approval`
    case 'financing_link_sent':
      return `Application link generated for ${meta.lender}`
    default:
      return ''
  }
}
