import type { SupabaseClient } from '@supabase/supabase-js'
import { executeWaterfall, type WaterfallResult } from './waterfall'
import type { LenderApplicationResponse, LenderSlug } from './types'

/**
 * Resume a waterfall after receiving an async lender callback (webhook).
 *
 * When an API-based lender (CareCredit, Sunbit) returns `pending` during
 * the initial waterfall, execution pauses and the waterfall step is saved.
 * When the lender calls back with a result, this function:
 * 1. Updates the submission record
 * 2. If approved → marks the application approved
 * 3. If denied → advances the step and re-runs the waterfall from the next lender
 */
export async function resumeWaterfall(
  applicationId: string,
  lenderSlug: LenderSlug,
  lenderResponse: LenderApplicationResponse,
  supabase: SupabaseClient
): Promise<WaterfallResult> {
  // 1. Load the application
  const { data: application, error: appError } = await supabase
    .from('financing_applications')
    .select('id, organization_id, lead_id, status, current_waterfall_step, waterfall_config, approved_lender_slug, approved_amount')
    .eq('id', applicationId)
    .single()

  if (appError || !application) {
    throw new Error(`Application not found: ${applicationId}`)
  }

  // Check if already completed (idempotency)
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

  const organizationId = application.organization_id

  // 2. Find the pending submission for this lender
  const { data: submission } = await supabase
    .from('financing_submissions')
    .select('id, application_id, lender_slug, status, external_application_id')
    .eq('application_id', applicationId)
    .eq('lender_slug', lenderSlug)
    .eq('status', 'submitted')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (!submission) {
    throw new Error(`No pending submission found for ${lenderSlug} on application ${applicationId}`)
  }

  // 3. Update the submission with the lender response
  await supabase
    .from('financing_submissions')
    .update({
      status: lenderResponse.status,
      external_application_id: lenderResponse.external_id || submission.external_application_id,
      response_data: {
        approved_amount: lenderResponse.approved_amount,
        terms: lenderResponse.terms,
        denial_reason_code: lenderResponse.denial_reason_code,
      },
      responded_at: new Date().toISOString(),
    })
    .eq('id', submission.id)

  // 4. Handle the response
  if (lenderResponse.status === 'approved') {
    // Mark application as approved
    await supabase
      .from('financing_applications')
      .update({
        status: 'approved',
        approved_lender_slug: lenderSlug,
        approved_amount: lenderResponse.approved_amount || null,
        approved_terms: lenderResponse.terms || null,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', applicationId)

    // Update lead
    await supabase
      .from('leads')
      .update({
        financing_approved: true,
        financing_amount: lenderResponse.approved_amount || null,
        financing_application_id: applicationId,
      })
      .eq('id', application.lead_id)

    // Log activity (non-blocking)
    try {
      await supabase
        .from('lead_activities')
        .insert({
          organization_id: organizationId,
          lead_id: application.lead_id,
          activity_type: 'financing_approved',
          title: `Financing approved by ${lenderSlug}`,
          description: lenderResponse.approved_amount
            ? `Approved for $${lenderResponse.approved_amount.toLocaleString()} (via webhook callback)`
            : 'Application approved (via webhook callback)',
          metadata: {
            lender: lenderSlug,
            approved_amount: lenderResponse.approved_amount,
            terms: lenderResponse.terms,
            source: 'webhook',
          },
        })
    } catch { /* Non-blocking */ }

    return {
      application_id: applicationId,
      status: 'approved',
      approved_lender: lenderSlug,
      approved_amount: lenderResponse.approved_amount,
      current_step: application.current_waterfall_step,
      total_steps: application.waterfall_config.lenders.length,
    }
  }

  if (lenderResponse.status === 'denied' || lenderResponse.status === 'error') {
    // Log denial (non-blocking)
    try {
      await supabase
        .from('lead_activities')
        .insert({
          organization_id: organizationId,
          lead_id: application.lead_id,
          activity_type: 'financing_lender_denied',
          title: `Financing denied by ${lenderSlug}`,
          description: lenderResponse.denial_reason_code
            ? `Reason: ${lenderResponse.denial_reason_code} (via webhook callback)`
            : 'Application denied (via webhook callback)',
          metadata: {
            lender: lenderSlug,
            reason: lenderResponse.denial_reason_code || lenderResponse.error_message,
            source: 'webhook',
          },
        })
    } catch { /* Non-blocking */ }

    // Advance waterfall step and continue with remaining lenders
    const nextStep = application.current_waterfall_step + 1
    await supabase
      .from('financing_applications')
      .update({
        current_waterfall_step: nextStep,
        updated_at: new Date().toISOString(),
      })
      .eq('id', applicationId)

    // Continue waterfall from next lender
    return executeWaterfall(applicationId, supabase, organizationId)
  }

  // Still pending — no action needed (duplicate webhook or status unchanged)
  return {
    application_id: applicationId,
    status: 'in_progress',
    current_step: application.current_waterfall_step,
    total_steps: application.waterfall_config.lenders.length,
  }
}

/**
 * Look up an application by the lender's external application ID.
 * Used by webhook handlers to find the internal application.
 */
export async function findApplicationByExternalId(
  supabase: SupabaseClient,
  lenderSlug: LenderSlug,
  externalId: string
): Promise<{ applicationId: string; organizationId: string } | null> {
  const { data: submission } = await supabase
    .from('financing_submissions')
    .select('application_id, organization_id')
    .eq('lender_slug', lenderSlug)
    .eq('external_application_id', externalId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (!submission) return null

  return {
    applicationId: submission.application_id,
    organizationId: submission.organization_id,
  }
}
