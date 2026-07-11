import { NextResponse, type NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { checkForwardSecret } from '@/lib/bridges/dion/forward-secret'
import { safeParseConsumedEvent } from '@/lib/bridges/dion/consumed'
import { handleEncounterSummarized } from '@/lib/bridges/dion-encounter-brief'

/**
 * Dion bus receiver — LI's FIRST inbound bus surface, the mirror of Dion
 * Clinical's /api/bus/receive. The hub fans clinical.* "a visit was summarized"
 * events (clinical.scribe_completed / clinical.encounter_completed) here; LI
 * pulls a follow-up brief and lands it on the lead (see dion-encounter-brief.ts).
 *
 * Contract with the hub's fan-out (bus-fanout.ts):
 *   403 → bad/absent machine secret
 *   400 → malformed JSON or an event outside our consumed catalog → the hub
 *         marks it `unconsumed` (terminal) rather than retrying forever
 *   200 → { accepted } on first delivery, { accepted, duplicate: true } on replay
 *
 * Durability: we RECORD every accepted event to dion_inbox (idempotent on the
 * envelope id) and 200 the hub immediately, THEN process. A processing failure
 * is captured on the row (process_error, processed_at stays null) for an internal
 * reprocess pass — it must NOT surface as a 5xx, or the hub redelivers, we dedupe
 * it, and it never gets reprocessed.
 *
 * Auth: shared `x-forward-secret` (DION_BUS_SECRET / DION_BUS_INBOUND_SECRET).
 */
export const dynamic = 'force-dynamic'

function hasServiceRole(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
}

export async function POST(req: NextRequest) {
  const auth = checkForwardSecret(req.headers.get('x-forward-secret'))
  if (!auth.ok) {
    return auth.reason === 'unconfigured'
      ? NextResponse.json({ error: 'bus receiver not configured' }, { status: 503 })
      : NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!hasServiceRole()) {
    return NextResponse.json({ error: 'service role not configured' }, { status: 503 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 })
  }

  const result = safeParseConsumedEvent(body)
  if (!result.success) {
    return NextResponse.json(
      { rejected: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) },
      { status: 400 },
    )
  }

  const event = result.data
  const supabase = createServiceClient()

  // Idempotent record. A redelivery collides on the envelope id (pk) → duplicate.
  const { error: insErr } = await supabase.from('dion_inbox').insert({
    id: event.id,
    type: event.type,
    source: event.source,
    payload: event,
  })
  if (insErr) {
    if (insErr.code === '23505') {
      return NextResponse.json({ accepted: event.type, duplicate: true })
    }
    console.error('[bus/receive] inbox record failed:', insErr.message)
    return NextResponse.json({ error: 'record failed' }, { status: 500 })
  }

  // Process inline (best-effort). Failures are captured for reprocessing, not
  // returned as 5xx — the hub already delivered successfully.
  try {
    const outcome = await handleEncounterSummarized(supabase, event)
    await supabase
      .from('dion_inbox')
      .update({ processed_at: new Date().toISOString(), process_error: null })
      .eq('id', event.id)
    console.log('[bus/receive] processed', event.type, outcome.status)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'processing failed'
    await supabase.from('dion_inbox').update({ process_error: message }).eq('id', event.id)
    console.error('[bus/receive] processing failed (will reprocess):', event.type, message)
  }

  return NextResponse.json({ accepted: event.type })
}
