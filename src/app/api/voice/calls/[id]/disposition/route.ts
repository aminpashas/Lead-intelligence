/**
 * PATCH /api/voice/calls/[id]/disposition — staff records the outcome of a call.
 *
 * Called from the browser softphone as a call winds down. It does three things,
 * any of which may be present in a single request:
 *
 *   1. Outcome + notes — the staffer's disposition. Written to voice_calls.outcome /
 *      outcome_notes, kept separate from the Twilio status callback so a human
 *      outcome is never clobbered by an automated status update.
 *   2. Auto-summary — whenever a browser call is answered or a voicemail is left, a
 *      human-readable `transcript_summary` is composed from the call's facts + notes
 *      so the conversation timeline shows a real entry (these calls have no AI
 *      transcript). The widget fires this automatically the moment such a call ends,
 *      then again (enriched) if the staffer picks an outcome or types notes.
 *   3. Contact capture — for a manual dial to a number that matched no lead, the
 *      staffer can fill in first/last/email. We mint a real PII-encrypted lead
 *      (deduped by phone hash) and back-link this call to it.
 *
 * Everything is org-scoped so a staffer can only disposition their own org's calls.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { encryptLeadPII, searchHash } from '@/lib/encryption'
import { formatToE164 } from '@/lib/leads/phone'
import { syncStaffCallThreadMarker } from '@/lib/voice/staff-call-thread'
import { recordAudit } from '@/lib/audit/record'
import { hasOwnTranscript } from '@/lib/voice/call-summary-guard'
import { applyStageMove } from '@/lib/pipeline/stage-move'

const OUTCOME_VALUES = [
  'appointment_booked',
  'callback_requested',
  'interested',
  'not_interested',
  'wrong_number',
  'do_not_call',
  'voicemail_left',
  'no_answer',
  'technical_failure',
  'transferred',
] as const

/**
 * Outcomes that mean a human conversation actually happened. Only these count as
 * real contact: they stamp `last_contacted_at` and may advance the early funnel.
 * A voicemail / no-answer / wrong number is an ATTEMPT, not communication — it
 * must not push a lead out of New Lead / No Communication (unqualified stamping
 * is exactly how every voicemailed lead used to end up in Following Up after the
 * nightly promoteEngagedNewLeads sweep).
 */
const CONNECTED_OUTCOMES: ReadonlySet<string> = new Set([
  'appointment_booked',
  'interested',
  'callback_requested',
  'not_interested',
  'transferred',
  'do_not_call', // they answered and said so — a conversation, even if a short one
])

/** Early-funnel stages a connected call advances to Following Up ('contacted'). */
const ADVANCE_FROM_SLUGS: ReadonlySet<string> = new Set(['new', 'no-communication'])

/** Lifecycle statuses that must never be reactivated by a call log. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['lost', 'disqualified', 'completed', 'in_treatment'])

const bodySchema = z.object({
  // Outcome is now optional: an auto-summary write (fired when an answered/voicemail
  // call ends) carries no explicit disposition, only the facts + any live notes.
  outcome: z.enum(OUTCOME_VALUES).optional(),
  notes: z.string().max(2000).optional(),
  // Duration the browser observed (Twilio's status callback can lag); used only to
  // enrich the summary when the row's own duration hasn't landed yet.
  duration_seconds: z.number().int().min(0).max(24 * 60 * 60).optional(),
  // Capture-the-contact for a nameless manual dial. Ignored when the call already
  // has a lead.
  contact: z
    .object({
      first_name: z.string().trim().min(1).max(120),
      last_name: z.string().trim().max(120).optional(),
      email: z.string().trim().email().max(200).optional().or(z.literal('')),
    })
    .optional(),
})

const OUTCOME_LABEL: Record<(typeof OUTCOME_VALUES)[number], string> = {
  appointment_booked: 'Appointment booked',
  callback_requested: 'Callback requested',
  interested: 'Interested',
  not_interested: 'Not interested',
  wrong_number: 'Wrong number',
  do_not_call: 'Do not call',
  voicemail_left: 'Left voicemail',
  no_answer: 'No answer',
  technical_failure: 'Technical failure',
  transferred: 'Transferred',
}

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Compose the human-readable summary shown in call history for a staff-placed call.
 * Kept factual and terse: what kind of call, how long, the outcome, then the notes.
 * Tweak the wording here to change how these calls read in the timeline.
 */
function buildSummary(input: {
  direction: 'inbound' | 'outbound'
  durationSeconds: number
  outcome?: (typeof OUTCOME_VALUES)[number]
  notes?: string
}): string {
  const parts: string[] = []
  const lead = input.direction === 'outbound' ? 'Outbound call' : 'Inbound call'
  parts.push(input.durationSeconds > 0 ? `${lead} · ${fmtDuration(input.durationSeconds)}` : lead)
  if (input.outcome) parts.push(OUTCOME_LABEL[input.outcome])
  else if (input.durationSeconds > 0) parts.push('Answered')
  let summary = parts.join(' · ') + '.'
  const notes = input.notes?.trim()
  if (notes) summary += ` ${notes}`
  return summary
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const authClient = await createClient()

  // Effective org honors an agency_admin's entered client account. We then write
  // through the service client scoped to that org — voice_calls RLS keys on the
  // caller's HOME org, which would block an agency admin managing a client.
  const { orgId } = await resolveActiveOrg(authClient)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = bodySchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
  const { outcome, notes, duration_seconds, contact } = parsed.data

  const supabase = createServiceClient()

  // Load the call so we can compose an accurate summary and know if it needs a lead.
  const { data: call } = await supabase
    .from('voice_calls')
    .select('id, lead_id, direction, duration_seconds, to_number, call_mode, transcript, transcript_summary, outcome_notes')
    .eq('id', id)
    .eq('organization_id', orgId)
    .maybeSingle()
  if (!call) return NextResponse.json({ error: 'Call not found' }, { status: 404 })

  // ── Contact capture — mint a real lead for a nameless manual dial ────────────
  let leadId: string | null = call.lead_id
  // True only when THIS request minted a brand-new lead (not matched an existing
  // one) — surfaced to the softphone so it can tell the staffer a contact was created.
  let leadCreated = false
  if (contact && !leadId) {
    const phone = formatToE164(call.to_number) ?? call.to_number
    const phoneHash = searchHash(phone)

    // Dedupe: a lead may have been created for this number since the call started.
    if (phoneHash) {
      const { data: existing } = await supabase
        .from('leads')
        .select('id')
        .eq('organization_id', orgId)
        .eq('phone_hash', phoneHash)
        .limit(1)
        .maybeSingle()
      if (existing) leadId = existing.id
    }

    if (!leadId) {
      const { data: defaultStage } = await supabase
        .from('pipeline_stages')
        .select('id')
        .eq('organization_id', orgId)
        .eq('is_default', true)
        .maybeSingle()

      const insertData = encryptLeadPII({
        organization_id: orgId,
        stage_id: defaultStage?.id,
        first_name: contact.first_name,
        last_name: contact.last_name || null,
        email: contact.email || null,
        phone,
        phone_formatted: phone,
        source_type: 'manual_dialer',
        // Deliberately NOT setting any consent flag: a staffer manually reaching this
        // person once does not grant autodialer/marketing consent. Consent stays
        // default-off so future automated outreach still runs the normal gate.
      })

      const { data: newLead, error: leadErr } = await supabase
        .from('leads')
        .insert(insertData)
        .select('id')
        .single()
      if (leadErr || !newLead) {
        return NextResponse.json({ error: 'Failed to create contact' }, { status: 500 })
      }
      leadId = newLead.id
      leadCreated = true

      await supabase.from('lead_activities').insert({
        organization_id: orgId,
        lead_id: leadId,
        activity_type: 'created',
        title: 'Lead created from call',
        description: `${contact.first_name} ${contact.last_name || ''} captured during a call`.trim(),
      })
    }
  }

  // ── Outcome + notes + composed summary ───────────────────────────────────────
  const effectiveDuration = duration_seconds ?? call.duration_seconds ?? 0
  const summary = buildSummary({
    direction: call.direction,
    durationSeconds: effectiveDuration,
    outcome,
    notes,
  })

  // Only recompose the summary for calls that have no transcript of their own —
  // see hasOwnTranscript for why overwriting an AI call's summary loses data.
  const updates: Record<string, unknown> = {}
  if (!hasOwnTranscript(call)) updates.transcript_summary = summary
  if (outcome) updates.outcome = outcome
  if (notes !== undefined) updates.outcome_notes = notes || null
  if (leadId && leadId !== call.lead_id) updates.lead_id = leadId
  // Only advance duration from the client's observation when the row hasn't got one.
  if (duration_seconds !== undefined && !call.duration_seconds) {
    updates.duration_seconds = duration_seconds
  }

  const { error } = await supabase
    .from('voice_calls')
    .update(updates)
    .eq('id', id)
    .eq('organization_id', orgId)

  if (error) return NextResponse.json({ error: 'Failed to save disposition' }, { status: 500 })

  // Amending the notes on an already-dispositioned call overwrites what was
  // there. voice_calls is excluded from the row-change audit trigger, so record
  // the prior value explicitly — otherwise the previous notes are unrecoverable
  // and there's no record of who changed them.
  if (notes !== undefined && (call.outcome_notes ?? null) !== (notes || null)) {
    const { data: actor } = await authClient.auth.getUser()
    await recordAudit(supabase, {
      organizationId: orgId,
      action: 'voice_call.notes_amended',
      actor: { actorType: 'user', actorId: actor.user?.id ?? null },
      source: 'api_route',
      resourceType: 'voice_calls',
      resourceId: id,
      before: { outcome_notes: call.outcome_notes ?? null },
      after: { outcome_notes: notes || null },
      changedFields: ['outcome_notes'],
      metadata: { lead_id: leadId },
    })
  }

  // If the staffer marked do-not-call, honor it on the lead immediately.
  if (outcome === 'do_not_call' && leadId) {
    await supabase.from('leads').update({ do_not_call: true }).eq('id', leadId).eq('organization_id', orgId)
  }

  // ── Outcome-driven contact effects ───────────────────────────────────────────
  // The staffer's outcome is the ground truth for whether communication happened.
  // Connected outcomes stamp last_contacted_at (the Twilio callback only stamps
  // >60s calls, so a genuine short conversation is stamped here); an attempt-only
  // outcome (voicemail/no-answer/wrong number) deliberately leaves the lead's
  // contact state untouched so it stays in New Lead / No Communication.
  if (outcome && CONNECTED_OUTCOMES.has(outcome) && leadId) {
    await supabase
      .from('leads')
      .update({ last_contacted_at: new Date().toISOString() })
      .eq('id', leadId)
      .eq('organization_id', orgId)

    // A real conversation moves an unworked lead into Following Up right away, so
    // the board reflects what the staffer just logged instead of waiting for the
    // nightly sweep. Do-not-call leads stay put — promoting a lead into a working
    // column while silencing its channels would only invite more outreach.
    if (outcome !== 'do_not_call') {
      const { data } = await supabase
        .from('leads')
        .select('id, status, stage_id, stage:pipeline_stages(slug)')
        .eq('id', leadId)
        .eq('organization_id', orgId)
        .maybeSingle()
      // leads.stage_id → pipeline_stages is many-to-one, so the embed is a single
      // object — but supabase-js's string parser can't prove that, hence the cast.
      const leadRow = data as { status: string | null; stage: { slug: string } | { slug: string }[] | null } | null
      const stageRel = leadRow?.stage
      const stageSlug = (Array.isArray(stageRel) ? stageRel[0]?.slug : stageRel?.slug) ?? null
      const status = leadRow?.status ?? null
      if (stageSlug && ADVANCE_FROM_SLUGS.has(stageSlug) && !(status && TERMINAL_STATUSES.has(status))) {
        const { data: contactedStage } = await supabase
          .from('pipeline_stages')
          .select('id')
          .eq('organization_id', orgId)
          .eq('slug', 'contacted')
          .maybeSingle()
        if (contactedStage) {
          const { data: actor } = await authClient.auth.getUser()
          // Automations suppressed: logging a call outcome is a record of what
          // happened, not a hand-drag into the funnel — it must not mass-enroll
          // leads into stage-entry campaigns as a side effect.
          await applyStageMove(supabase, {
            organizationId: orgId,
            leadIds: [leadId],
            toStageId: contactedStage.id,
            actor: { type: 'user', userId: actor.user?.id ?? undefined, source: 'call_disposition' },
            suppressAutomations: true,
            activityTitle: 'Reached on a call — moved to Following Up',
            activityMetadata: { voice_call_id: id, outcome },
          })
        }
      }
    }
  }

  // Reflect the disposition summary in the Conversations inbox marker so the
  // thread shows the staffer's real outcome (e.g. "Interested") rather than the
  // raw Twilio status. Upserts in case this fires before the status callback.
  if (leadId) {
    await syncStaffCallThreadMarker(supabase, {
      voiceCallId: id,
      organizationId: orgId,
      leadId,
      direction: call.direction === 'inbound' ? 'inbound' : 'outbound',
      body: summary,
    })
  }

  return NextResponse.json({ ok: true, lead_id: leadId, lead_created: leadCreated })
}
