import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { checkoutReconcileSchema } from '@/lib/validators/financing'
import {
  applyReconciliation, computeCheckoutProgress,
  type CheckoutSession, type CheckoutSubApp, type SubAppStatus,
} from '@/lib/financing/checkout-session'
import type { LenderSlug } from '@/lib/financing/types'

type SubAppRow = {
  lender_slug: string
  lender_name: string
  requested_amount: number
  term: unknown
  status: string
  funded_amount: number
  confirmed_by: string | null
  application_url: string | null
}

function toSession(treatmentTotal: number, rows: SubAppRow[]): CheckoutSession {
  const sub_apps: CheckoutSubApp[] = rows.map(r => ({
    lender_slug: r.lender_slug as LenderSlug,
    lender_name: r.lender_name,
    requested_amount: Number(r.requested_amount),
    term: r.term as CheckoutSubApp['term'],
    status: r.status as SubAppStatus,
    funded_amount: Number(r.funded_amount),
    confirmed_by: (r.confirmed_by as CheckoutSubApp['confirmed_by']) ?? null,
  }))
  return { treatment_total: treatmentTotal, sub_apps }
}

// Public "pick back up" view. The token IS the capability, so this uses the
// service client (bypasses RLS) but only exposes lender/amount/status — no PII
// lives on these tables.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  const svc = createServiceClient()

  const { data: session } = await svc
    .from('financing_checkout_sessions')
    .select('id, treatment_total')
    .eq('resume_token', token)
    .single()
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: rows } = await svc
    .from('financing_checkout_subapps')
    .select('lender_slug, lender_name, requested_amount, term, status, funded_amount, confirmed_by, application_url')
    .eq('session_id', session.id)
    .order('created_at', { ascending: true })

  const built = toSession(Number(session.treatment_total), (rows ?? []) as SubAppRow[])
  const progress = computeCheckoutProgress(built)
  return NextResponse.json({
    resume_token: token,
    treatment_total: built.treatment_total,
    sub_apps: built.sub_apps.map(sa => ({
      lender_slug: sa.lender_slug, lender_name: sa.lender_name,
      requested_amount: sa.requested_amount, status: sa.status,
      funded_amount: sa.funded_amount, application_url: ((rows ?? []) as SubAppRow[]).find(r => r.lender_slug === sa.lender_slug)?.application_url ?? null,
    })),
    progress,
  })
}

// Reconcile one sub-application. Staff (authenticated, org matches) may set any
// status incl. 'funded'. Patient self-report (token only) is limited and a
// self-reported 'funded' is downgraded to 'approved' — staff must confirm money.
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await ctx.params
    const svc = createServiceClient()

    const { data: session } = await svc
      .from('financing_checkout_sessions')
      .select('id, organization_id, treatment_total')
      .eq('resume_token', token)
      .single()
    if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const parsed = checkoutReconcileSchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors }, { status: 400 })
    }
    const body = parsed.data

    // Is this an authenticated staff member for this org?
    let isStaff = false
    try {
      const authed = await createClient()
      const { data: { user } } = await authed.auth.getUser()
      if (user) {
        const { orgId } = await resolveActiveOrg(authed)
        isStaff = !!orgId && orgId === session.organization_id
      }
    } catch { /* unauthenticated — treat as patient */ }

    let status: SubAppStatus = body.status
    let confirmed_by: 'staff' | 'patient' | 'webhook' = isStaff ? (body.confirmed_by ?? 'staff') : 'patient'

    if (!isStaff) {
      // Patient self-report: only progress signals, and 'funded' needs staff sign-off.
      const allowed: SubAppStatus[] = ['started', 'approved', 'funded']
      if (!allowed.includes(status)) {
        return NextResponse.json({ error: 'Patients can only report started / approved.' }, { status: 403 })
      }
      if (status === 'funded') status = 'approved' // downgrade until staff confirms
      confirmed_by = 'patient'
    }

    const { data: rows } = await svc
      .from('financing_checkout_subapps')
      .select('lender_slug, lender_name, requested_amount, term, status, funded_amount, confirmed_by, application_url')
      .eq('session_id', session.id)
    const subapp = ((rows ?? []) as SubAppRow[]).find(r => r.lender_slug === body.lender_slug)
    if (!subapp) return NextResponse.json({ error: 'Lender not in this session' }, { status: 404 })

    const funded_amount = status === 'funded'
      ? (body.funded_amount ?? Number(subapp.requested_amount))
      : Number(subapp.funded_amount)

    const { error: upErr } = await svc
      .from('financing_checkout_subapps')
      .update({ status, funded_amount, confirmed_by, updated_at: new Date().toISOString() })
      .eq('session_id', session.id)
      .eq('lender_slug', body.lender_slug)
    if (upErr) {
      console.error('[financing/checkout PATCH] update failed:', upErr.message)
      return NextResponse.json({ error: 'Could not update sub-application' }, { status: 500 })
    }

    // Recompute progress and roll the session status forward.
    const built = toSession(Number(session.treatment_total), (rows ?? []) as SubAppRow[])
    const next = applyReconciliation(built, { lender_slug: body.lender_slug as LenderSlug, status, funded_amount, confirmed_by })
    const progress = computeCheckoutProgress(next)
    await svc.from('financing_checkout_sessions')
      .update({ status: progress.status, updated_at: new Date().toISOString() })
      .eq('id', session.id)

    return NextResponse.json({ progress, actor: isStaff ? 'staff' : 'patient' })
  } catch (error) {
    console.error('[financing/checkout PATCH] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
