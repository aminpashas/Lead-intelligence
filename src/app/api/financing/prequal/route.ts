import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { prequalRequestSchema } from '@/lib/validators/financing'
import { getLenderAdapter } from '@/lib/financing/adapters'
import { decryptCredentials } from '@/lib/financing/encryption-helpers'
import { runCollectAllPrequal, type CollectAllLender } from '@/lib/financing/collect-all'
import type { LenderSlug } from '@/lib/financing/types'
import type { SupabaseClient } from '@supabase/supabase-js'

type Ctx = { orgId: string; leadId: string; amount: number; db: SupabaseClient }

/**
 * Resolve the run context from EITHER an authenticated staff member (org from
 * session + lead/amount from the body) OR a public share token (org/lead/amount
 * from the financing_applications row, service client). Returns null if neither.
 */
async function resolveContext(request: NextRequest): Promise<Ctx | { error: string; status: number } | null> {
  const shareToken = request.headers.get('x-share-token')

  // Staff path.
  const authed = await createClient()
  const { data: { user } } = await authed.auth.getUser()
  if (user) {
    const { orgId } = await resolveActiveOrg(authed)
    if (!orgId) return { error: 'Unauthorized', status: 401 }
    const parsed = prequalRequestSchema.safeParse(await request.json())
    if (!parsed.success) return { error: 'Validation failed', status: 400 }
    return { orgId, leadId: parsed.data.lead_id, amount: parsed.data.amount, db: authed }
  }

  // Public share-token path.
  if (shareToken) {
    const svc = createServiceClient()
    const { data: app } = await svc
      .from('financing_applications')
      .select('organization_id, lead_id, requested_amount, expires_at')
      .eq('share_token', shareToken)
      .single()
    if (!app) return { error: 'Invalid financing link', status: 404 }
    if (app.expires_at && new Date(app.expires_at) < new Date()) {
      return { error: 'This financing link has expired', status: 410 }
    }
    return {
      orgId: app.organization_id,
      leadId: app.lead_id,
      amount: Number(app.requested_amount) || 20000,
      db: svc,
    }
  }

  return { error: 'Unauthorized', status: 401 }
}

/**
 * POST /api/financing/prequal
 *
 * Run a soft-pull prequalification across ALL active lenders in parallel, persist
 * every per-lender result, and return the recommended stacked coverage plan.
 * Works for staff (session auth) or a patient on the public page (x-share-token).
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await resolveContext(request)
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if ('error' in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

    const { orgId, leadId, amount, db } = ctx

    const { data: lenderConfigs } = await db
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
      const credentials = lc.credentials_encrypted ? decryptCredentials(lc.credentials_encrypted) : undefined
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
      leadId, organizationId: orgId, requestedAmount: amount, lenders,
      persist: async (rows) => {
        if (rows.length === 0) return
        const { error } = await db.from('financing_prequal_offers').insert(rows.map(({ offer, runId }) => ({
          organization_id: orgId, lead_id: leadId, run_id: runId, requested_amount: amount,
          lender_slug: offer.lender_slug, lender_name: offer.lender_name,
          decision: offer.decision, approved_amount: offer.approved_amount, terms: offer.terms,
        })))
        if (error) console.error('[financing/prequal] persist failed:', error.message)
      },
    })

    return NextResponse.json(result)
  } catch (error) {
    console.error('[financing/prequal] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
