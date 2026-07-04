import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { checkoutCreateSchema } from '@/lib/validators/financing'

/**
 * POST /api/financing/checkout
 *
 * Staff creates a checkout session from a chosen stacked plan: one session +
 * N per-lender sub-applications. Returns a durable, reusable resume_token that
 * both patient and staff use to "pick back up" the multi-lender process.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { orgId } = await resolveActiveOrg(supabase)
    if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const parsed = checkoutCreateSchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }
    const { lead_id, treatment_total, selections } = parsed.data

    const resumeToken = globalThis.crypto.randomUUID()

    const { data: session, error: sErr } = await supabase
      .from('financing_checkout_sessions')
      .insert({
        organization_id: orgId,
        lead_id,
        treatment_total,
        resume_token: resumeToken,
        status: 'in_progress',
      })
      .select('id')
      .single()

    if (sErr || !session) {
      console.error('[financing/checkout] session insert failed:', sErr?.message)
      return NextResponse.json({ error: 'Could not create checkout session' }, { status: 500 })
    }

    const { error: subErr } = await supabase.from('financing_checkout_subapps').insert(
      selections.map(sel => ({
        organization_id: orgId,
        session_id: session.id,
        lender_slug: sel.lender_slug,
        lender_name: sel.lender_name,
        requested_amount: sel.requested_amount,
        term: sel.term,
        // A link URL means the patient's application was dispatched to that lender.
        status: sel.application_url ? 'link_sent' : 'selected',
        funded_amount: 0,
        application_url: sel.application_url ?? null,
      })),
    )
    if (subErr) {
      console.error('[financing/checkout] subapps insert failed:', subErr.message)
      return NextResponse.json({ error: 'Could not create checkout sub-applications' }, { status: 500 })
    }

    return NextResponse.json({ resume_token: resumeToken, session_id: session.id })
  } catch (error) {
    console.error('[financing/checkout] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
