import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { advanceStepByCase } from '@/lib/treatment/treatment-closing'

/**
 * POST /api/webhooks/lab/sdl — Smile Design Lab status callbacks.
 *
 * SDL's outbox dispatcher POSTs { id, type, data: { caseId, caseNumber,
 * fromStatus, toStatus, occurredAt } } signed with `x-sdl-signature:
 * sha256=<hmac-hex>` over the raw body. The signing key is the per-org
 * webhook_secret stored in the smile_design_lab connector config. Like the
 * financing webhooks, we resolve the org by the external case id first, then
 * verify the signature before applying anything.
 */

const KNOWN_STATUSES = new Set([
  'draft', 'submitted', 'accepted', 'declined', 'design_review',
  'manufacturing', 'shipped', 'delivered', 'completed', 'cancelled',
])

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  let payload: { id?: string; type?: string; data?: Record<string, unknown> }
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const data = payload.data ?? {}
  const sdlCaseId = typeof data.caseId === 'string' ? data.caseId : null
  const toStatus = typeof data.toStatus === 'string' ? data.toStatus : null
  if (!sdlCaseId || !toStatus) {
    return NextResponse.json({ error: 'Missing caseId/toStatus' }, { status: 400 })
  }

  const supabase = createServiceClient()

  const { data: order } = await supabase
    .from('lab_orders')
    .select('id, organization_id, clinical_case_id, status, status_history')
    .eq('lab_provider', 'smile_design_lab')
    .eq('external_case_id', sdlCaseId)
    .maybeSingle()
  if (!order) {
    // Unknown case — acknowledge so SDL doesn't retry forever, but flag it.
    return NextResponse.json({ received: true, matched: false })
  }

  // Signature verification against the org's webhook secret (mandatory).
  const { data: config } = await supabase
    .from('connector_configs')
    .select('credentials')
    .eq('organization_id', order.organization_id)
    .eq('connector_type', 'smile_design_lab')
    .maybeSingle()
  const secret = ((config?.credentials ?? {}) as Record<string, string>).webhook_secret
  if (!secret) {
    return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 })
  }
  const signature = request.headers.get('x-sdl-signature') ?? ''
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')
  const sigBuf = Buffer.from(signature)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Apply the status (idempotent — same status twice is a no-op update).
  const newStatus = KNOWN_STATUSES.has(toStatus) ? toStatus : order.status
  const history = Array.isArray(order.status_history) ? order.status_history : []
  await supabase
    .from('lab_orders')
    .update({
      status: newStatus,
      status_history: [
        ...history,
        { from: order.status, to: toStatus, at: (data.occurredAt as string) ?? new Date().toISOString() },
      ],
    })
    .eq('id', order.id)

  // Delivered lab work → surgical-guide flag on the readiness checklist.
  if (toStatus === 'delivered' || toStatus === 'completed') {
    const { data: closing } = await supabase
      .from('treatment_closings')
      .select('id, records_checklist, records_confirmed_at')
      .eq('clinical_case_id', order.clinical_case_id)
      .maybeSingle()
    if (closing) {
      const checklist = { ...closing.records_checklist, lab_work_ordered: true, surgical_guide_ready: true }
      await supabase
        .from('treatment_closings')
        .update({ records_checklist: checklist })
        .eq('id', closing.id)
      if (Object.values(checklist).every(Boolean) && !closing.records_confirmed_at) {
        await advanceStepByCase(supabase, order.clinical_case_id, 'records_confirmed', {
          records_checklist: checklist,
        })
      }
    }
  }

  return NextResponse.json({ received: true, matched: true, status: newStatus })
}
