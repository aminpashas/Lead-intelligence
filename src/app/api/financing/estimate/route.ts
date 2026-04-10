import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { paymentEstimateRequestSchema } from '@/lib/validators/financing'
import { getLenderAdapter } from '@/lib/financing/adapters'
import { decryptCredentials } from '@/lib/financing/encryption-helpers'
import type { PaymentEstimate, LenderSlug } from '@/lib/financing/types'

/**
 * POST /api/financing/estimate
 *
 * Get payment estimates from all active lenders.
 * No application is created — this is a quick "as low as $X/month" lookup.
 * Used in the lead detail sidebar and financing card.
 */
export async function POST(request: NextRequest) {
  try {
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

    const body = await request.json()
    const validation = paymentEstimateRequestSchema.safeParse(body)
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const { amount } = validation.data
    const organizationId = profile.organization_id

    // Load active lenders
    const { data: lenderConfigs } = await supabase
      .from('financing_lender_configs')
      .select('lender_slug, credentials_encrypted, config, is_active')
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .order('priority_order', { ascending: true })

    if (!lenderConfigs || lenderConfigs.length === 0) {
      return NextResponse.json({ estimates: [], message: 'No active lenders configured' })
    }

    // Collect estimates from all lenders in parallel
    const estimatePromises = lenderConfigs.map(async (lc) => {
      const adapter = getLenderAdapter(lc.lender_slug as LenderSlug)
      if (!adapter.getPaymentEstimate) return []

      try {
        const credentials = lc.credentials_encrypted
          ? decryptCredentials(lc.credentials_encrypted)
          : undefined

        return await adapter.getPaymentEstimate(amount, lc.config || {}, credentials)
      } catch {
        // Individual lender failure shouldn't block others
        return []
      }
    })

    const results = await Promise.all(estimatePromises)
    const estimates: PaymentEstimate[] = results.flat()

    // Sort by monthly payment ascending (cheapest first)
    estimates.sort((a, b) => a.monthly_payment - b.monthly_payment)

    return NextResponse.json({
      estimates,
      amount,
      lender_count: lenderConfigs.length,
    })
  } catch (error) {
    console.error('[financing/estimate] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
