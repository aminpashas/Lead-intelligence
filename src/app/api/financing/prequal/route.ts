import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { prequalRequestSchema } from '@/lib/validators/financing'
import { getLenderAdapter } from '@/lib/financing/adapters'
import { decryptCredentials } from '@/lib/financing/encryption-helpers'
import { runCollectAllPrequal, type CollectAllLender } from '@/lib/financing/collect-all'
import type { LenderSlug } from '@/lib/financing/types'

/**
 * POST /api/financing/prequal
 *
 * Run a soft-pull prequalification across ALL active lenders in parallel, persist
 * every per-lender result, and return the recommended stacked coverage plan.
 * Unlike /estimate (indicative "as low as" only), this records approvals and
 * builds the multi-lender plan that covers the full treatment amount.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { orgId } = await resolveActiveOrg(supabase)
    if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json()
    const parsed = prequalRequestSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }
    const { lead_id, amount } = parsed.data

    const { data: lenderConfigs } = await supabase
      .from('financing_lender_configs')
      .select('lender_slug, credentials_encrypted, config, is_active')
      .eq('organization_id', orgId)
      .eq('is_active', true)
      .order('priority_order', { ascending: true })

    if (!lenderConfigs || lenderConfigs.length === 0) {
      return NextResponse.json({ offers: [], plan: null, message: 'No active lenders configured' })
    }

    const lenders: CollectAllLender[] = lenderConfigs.map((lc) => {
      const adapter = getLenderAdapter(lc.lender_slug as LenderSlug)
      const credentials = lc.credentials_encrypted
        ? decryptCredentials(lc.credentials_encrypted)
        : undefined
      return {
        slug: lc.lender_slug as LenderSlug,
        name: adapter.displayName,
        preQualify: adapter.preQualify && credentials
          ? () => adapter.preQualify!({ requested_amount: amount }, credentials)
          : undefined,
        getPaymentEstimate: adapter.getPaymentEstimate
          ? () => adapter.getPaymentEstimate!(amount, lc.config || {}, credentials)
          : undefined,
      }
    })

    const result = await runCollectAllPrequal({
      leadId: lead_id,
      organizationId: orgId,
      requestedAmount: amount,
      lenders,
      persist: async (rows) => {
        if (rows.length === 0) return
        const { error } = await supabase.from('financing_prequal_offers').insert(
          rows.map(({ offer, runId }) => ({
            organization_id: orgId,
            lead_id,
            run_id: runId,
            requested_amount: amount,
            lender_slug: offer.lender_slug,
            lender_name: offer.lender_name,
            decision: offer.decision,
            approved_amount: offer.approved_amount,
            terms: offer.terms,
          })),
        )
        // Persistence failure shouldn't sink the live result the staff is waiting
        // on — log and continue (offers are still returned in-memory).
        if (error) console.error('[financing/prequal] persist failed:', error.message)
      },
    })

    return NextResponse.json(result)
  } catch (error) {
    console.error('[financing/prequal] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
