import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { getLenderAdapter } from '@/lib/financing/adapters'
import { decryptCredentials } from '@/lib/financing/encryption-helpers'
import { resumeWaterfall } from '@/lib/financing/waterfall-resume'
import { auditPHIWrite } from '@/lib/hipaa-audit'
import type { LenderSlug, LenderApplicationResponse } from '@/lib/financing/types'

/**
 * POST /api/cron/financing
 *
 * Scheduled job (hourly) that:
 * 1. Expires applications past their TTL
 * 2. Polls pending submissions for async lender results
 *
 * Protected by CRON_SECRET header.
 */
export async function POST(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()
  const results = { expired: 0, polled: 0, updated: 0, errors: 0 }

  // ── 1. Expire old applications ──
  try {
    const { data: expiredApps } = await supabase
      .from('financing_applications')
      .select('id, organization_id, lead_id')
      .in('status', ['pending', 'in_progress'])
      .lt('expires_at', new Date().toISOString())

    if (expiredApps && expiredApps.length > 0) {
      for (const app of expiredApps) {
        await supabase
          .from('financing_applications')
          .update({
            status: 'expired',
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', app.id)

        // Log activity
        await supabase
          .from('lead_activities')
          .insert({
            organization_id: app.organization_id,
            lead_id: app.lead_id,
            activity_type: 'financing_expired',
            title: 'Financing application expired',
            description: 'Application exceeded 24-hour time limit',
            metadata: { application_id: app.id },
          })
          .catch(() => {})

        // Audit log
        await auditPHIWrite(
          { supabase, organizationId: app.organization_id, actorType: 'cron' },
          'financing_application',
          app.id,
          'Financing application expired by cron job',
          ['financial']
        )

        results.expired++
      }
    }
  } catch (error) {
    console.error('[cron/financing] Expire error:', error)
    results.errors++
  }

  // ── 2. Poll pending submissions (API lenders with checkStatus) ──
  try {
    const { data: pendingSubmissions } = await supabase
      .from('financing_submissions')
      .select('id, organization_id, application_id, lender_slug, external_application_id')
      .eq('status', 'submitted')
      .not('external_application_id', 'is', null)
      // Only poll submissions older than 5 minutes (give webhooks a chance)
      .lt('submitted_at', new Date(Date.now() - 5 * 60 * 1000).toISOString())

    if (pendingSubmissions && pendingSubmissions.length > 0) {
      for (const submission of pendingSubmissions) {
        results.polled++

        try {
          const adapter = getLenderAdapter(submission.lender_slug as LenderSlug)
          if (!adapter.checkStatus) continue

          // Load lender credentials
          const { data: lenderConfig } = await supabase
            .from('financing_lender_configs')
            .select('credentials_encrypted')
            .eq('organization_id', submission.organization_id)
            .eq('lender_slug', submission.lender_slug)
            .single()

          if (!lenderConfig?.credentials_encrypted) continue

          const credentials = decryptCredentials(lenderConfig.credentials_encrypted)
          const response: LenderApplicationResponse = await adapter.checkStatus(
            submission.external_application_id!,
            credentials
          )

          // If status changed from pending, resume the waterfall
          if (response.status !== 'pending') {
            await resumeWaterfall(
              submission.application_id,
              submission.lender_slug as LenderSlug,
              response,
              supabase
            )
            results.updated++
          }
        } catch (error) {
          console.error(`[cron/financing] Poll error for submission ${submission.id}:`, error)
          results.errors++
        }
      }
    }
  } catch (error) {
    console.error('[cron/financing] Poll query error:', error)
    results.errors++
  }

  return NextResponse.json({
    success: true,
    timestamp: new Date().toISOString(),
    results,
  })
}
