/**
 * Reconcile estimated SMS costs against Twilio's real price.
 *
 * SMS cost is estimated at send time (per-segment guess) and recorded as an `estimated`
 * cost_event. Twilio populates the true `price` on the Message resource a few seconds-to-minutes
 * later, so this cron:
 *   Pass A — upgrades `estimated` SMS cost_events to `final` using the fetched Twilio price.
 *   Pass B — captures recent outbound SMS that never got an estimate (raw send paths, e.g.
 *            post-call follow-ups) so nothing escapes the ledger.
 *
 * Voice is already captured as `final` in the Retell webhook, and AI is exact at write time —
 * neither needs reconciling here.
 *
 * Schedule: every 15 min (vercel.json). Bounded per run to cap Twilio API calls.
 */

import twilio from 'twilio'
import { withCron } from '@/lib/cron/with-cron'
import { buildSmsCostEvent, recordCostEvent, loadMarkupConfig } from '@/lib/billing/cost-events'

const MAX_TWILIO_FETCHES = 120

export const POST = withCron('reconcile-costs', async ({ supabase }) => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (!accountSid || !authToken) {
    return { status: 'skipped', items: 0, data: { reason: 'twilio_not_configured' } }
  }
  const client = twilio(accountSid, authToken)

  // Cache markup config per org across the run (avoids one query per event).
  const markupCache = new Map<string, Awaited<ReturnType<typeof loadMarkupConfig>>>()
  const markupFor = async (orgId: string) => {
    if (!markupCache.has(orgId)) markupCache.set(orgId, await loadMarkupConfig(supabase, orgId))
    return markupCache.get(orgId) ?? null
  }

  let fetches = 0
  let reconciled = 0

  // Twilio prices are negative dollar strings (e.g. "-0.00790"); store the magnitude in cents.
  const finalize = async (args: {
    sid: string
    organizationId: string
    leadId: string | null
  }): Promise<void> => {
    if (fetches >= MAX_TWILIO_FETCHES) return
    fetches++
    const msg = await client.messages(args.sid).fetch()
    if (msg.price == null) return // not priced yet — retry next run, row stays estimated
    const costCents = Math.abs(parseFloat(msg.price)) * 100
    const segments = msg.numSegments ? parseInt(msg.numSegments, 10) : undefined
    await recordCostEvent(
      supabase,
      buildSmsCostEvent({
        organizationId: args.organizationId,
        externalId: args.sid,
        segments,
        costCents,
        status: 'final',
        markup: await markupFor(args.organizationId),
        leadId: args.leadId,
      }),
    )
    reconciled++
  }

  // ── Pass A: estimated SMS cost_events → final ──
  const { data: pending } = await supabase
    .from('cost_events')
    .select('external_id, organization_id, metadata')
    .eq('service', 'sms')
    .eq('status', 'estimated')
    .not('external_id', 'is', null)
    .order('event_at', { ascending: true })
    .limit(MAX_TWILIO_FETCHES)

  const seen = new Set<string>()
  for (const ev of pending ?? []) {
    const sid = ev.external_id as string
    seen.add(sid)
    try {
      await finalize({
        sid,
        organizationId: ev.organization_id as string,
        leadId: ((ev.metadata as Record<string, unknown>)?.lead_id as string) ?? null,
      })
    } catch {
      // Skip this one; the row stays estimated and retries next run.
    }
  }

  // ── Pass B: recent outbound SMS with no cost_event at all ──
  const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
  const { data: recentMsgs } = await supabase
    .from('messages')
    .select('external_id, organization_id, lead_id')
    .eq('channel', 'sms')
    .eq('direction', 'outbound')
    .not('external_id', 'is', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(300)

  type OutboundMsg = { external_id: string | null; organization_id: string; lead_id: string | null }
  const recent = (recentMsgs ?? []) as OutboundMsg[]
  const candidateSids = recent
    .map((m) => m.external_id ?? '')
    .filter((sid) => Boolean(sid) && !seen.has(sid) && sid.startsWith('SM'))

  // Which of these already have any cost_event? Skip those.
  const tracked = new Set<string>()
  if (candidateSids.length > 0) {
    const { data: existing } = await supabase
      .from('cost_events')
      .select('external_id')
      .eq('service', 'sms')
      .in('external_id', candidateSids)
    for (const row of existing ?? []) tracked.add(row.external_id as string)
  }

  for (const m of recent) {
    const sid = m.external_id ?? ''
    if (!sid || seen.has(sid) || tracked.has(sid) || !sid.startsWith('SM')) continue
    seen.add(sid)
    try {
      await finalize({
        sid,
        organizationId: m.organization_id as string,
        leadId: (m.lead_id as string) ?? null,
      })
    } catch {
      // Skip; next run retries.
    }
  }

  return { status: 'ok', items: reconciled, data: { fetches } }
})
