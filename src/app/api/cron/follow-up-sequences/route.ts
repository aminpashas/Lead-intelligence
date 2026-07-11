import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import {
  nextDueEnrollmentStep,
  isEnrollmentComplete,
  executableSteps,
  FALLBACK_FOLLOWUP_STEPS,
  type SchedulableStep,
} from '@/lib/automation/sequence-schedule'
import { loadSequence, executeSequenceStep, type SequenceWithSteps } from '@/lib/automation/sequences'
import { isSendAllowed } from '@/lib/messaging/test-allowlist'
import { decryptField } from '@/lib/encryption'
import { classifyContactedState } from '@/lib/pipeline/contacted-state'

type SupabaseServiceClient = ReturnType<typeof createServiceClient>

/**
 * Find (or create, for orgs born after the nurturing-stage migration) this
 * org's 'nurturing' pipeline_stages row. Stage-move only — no messaging.
 */
async function ensureNurturingStageId(supabase: SupabaseServiceClient, orgId: string): Promise<string | null> {
  const { data: existing } = await supabase
    .from('pipeline_stages').select('id').eq('organization_id', orgId).eq('slug', 'nurturing').maybeSingle()
  if (existing?.id) return existing.id

  const { data: maxRow } = await supabase
    .from('pipeline_stages').select('position').eq('organization_id', orgId)
    .order('position', { ascending: false }).limit(1).maybeSingle()
  const nextPos = (maxRow?.position ?? 0) + 1

  const { data: created } = await supabase
    .from('pipeline_stages')
    .insert({ organization_id: orgId, name: 'Nurturing', slug: 'nurturing', color: '#8B8B8B', position: nextPos, is_default: false })
    .select('id').maybeSingle()
  if (created?.id) return created.id

  // Lost the race to a concurrent insert (unique(organization_id, slug)) — re-select.
  const { data: retry } = await supabase
    .from('pipeline_stages').select('id').eq('organization_id', orgId).eq('slug', 'nurturing').maybeSingle()
  return retry?.id ?? null
}

/**
 * GET /api/cron/follow-up-sequences — fire the due step of each active
 * follow-up enrollment. Auth: Bearer CRON_SECRET (fail-closed).
 *
 * Steps come from the org's DB-defined 'new_lead_follow_up' sequence
 * (command-center editable: timing, channel, AI vs human owner per step);
 * orgs without one fall back to the legacy hardcoded cadence.
 *
 * SAFETY: default OFF (requires FOLLOWUP_SEQUENCES_ENABLED=true), every send is
 * allowlist- + consent-gated, and a lead that replied after enrolling is stopped.
 */
export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // Auto-messages leads — must be explicitly enabled.
  if (process.env.FOLLOWUP_SEQUENCES_ENABLED !== 'true') {
    return NextResponse.json({ skipped: 'FOLLOWUP_SEQUENCES_ENABLED not set' })
  }

  const supabase = createServiceClient()
  const nowMs = Date.now()
  const summary = { processed: 0, sent: 0, tasks: 0, skipped: 0, stopped: 0, completed: 0, errors: 0 }

  const { data: enrollments } = await supabase
    .from('follow_up_enrollments')
    .select('id, lead_id, organization_id, status, current_step, enrolled_at')
    .eq('status', 'active')
    .limit(500)

  // One sequence load per org per pass.
  const sequenceCache = new Map<string, SequenceWithSteps | null>()
  async function orgSequence(orgId: string): Promise<SequenceWithSteps | null> {
    if (!sequenceCache.has(orgId)) {
      sequenceCache.set(orgId, await loadSequence(supabase, orgId, 'new_lead_follow_up'))
    }
    return sequenceCache.get(orgId) ?? null
  }

  for (const e of enrollments || []) {
    summary.processed++
    try {
      const seq = await orgSequence(e.organization_id)
      // A defined-but-disabled sequence means "paused" — leave enrollments untouched.
      if (seq && !seq.enabled) { summary.skipped++; continue }
      const steps: SchedulableStep[] = seq ? seq.steps : FALLBACK_FOLLOWUP_STEPS
      const stopOnReply = seq?.stop_on_reply ?? true
      const stopOnBooking = seq?.stop_on_booking ?? true

      const due = nextDueEnrollmentStep(
        steps,
        { current_step: e.current_step, enrolled_at: e.enrolled_at, status: 'active' },
        nowMs
      )
      if (!due) {
        // Steps may have been removed/disabled mid-flight — close out exhausted enrollments.
        if (isEnrollmentComplete(steps, e)) {
          await supabase.from('follow_up_enrollments').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', e.id)
          summary.completed++
        } else {
          summary.skipped++
        }
        continue
      }

      const { data: lead } = await supabase
        .from('leads')
        .select('*')
        .eq('id', e.lead_id)
        .single()
      if (!lead) { summary.skipped++; continue }

      // Stop-on-reply: the lead engaged after enrolling → halt the sequence.
      if (stopOnReply && lead.last_responded_at && new Date(lead.last_responded_at).getTime() > new Date(e.enrolled_at).getTime()) {
        await supabase.from('follow_up_enrollments').update({ status: 'stopped', updated_at: new Date().toISOString() }).eq('id', e.id)
        summary.stopped++; continue
      }

      // Stop-on-booking: an upcoming appointment means the appointment
      // sequence owns this lead now.
      if (stopOnBooking) {
        const { data: upcoming } = await supabase
          .from('appointments')
          .select('id')
          .eq('lead_id', e.lead_id)
          .in('status', ['scheduled', 'confirmed'])
          .gte('scheduled_at', new Date(nowMs).toISOString())
          .limit(1)
          .maybeSingle()
        if (upcoming) {
          await supabase.from('follow_up_enrollments').update({ status: 'stopped', updated_at: new Date().toISOString() }).eq('id', e.id)
          summary.stopped++; continue
        }
      }

      // Test allowlist applies to direct sends (tasks/calls have their own gates).
      if (due.step.channel === 'sms' || due.step.channel === 'email') {
        const recipient = (due.step.channel === 'email'
          ? decryptField(lead.email) || lead.email
          : decryptField(lead.phone_formatted) || lead.phone_formatted) || ''
        if (!recipient || !isSendAllowed(recipient)) { summary.skipped++; continue }
      }

      const result = await executeSequenceStep(supabase, {
        organizationId: e.organization_id,
        lead,
        step: due.step,
        scopeId: e.id,
        source: 'follow_up_sequence',
      })
      if (result.status === 'sent' || result.status === 'call_initiated') summary.sent++
      else if (result.status === 'task_created' || result.status === 'escalated') summary.tasks++

      // Advance regardless of send outcome (avoid retry storms); complete on last step.
      const nextStep = e.current_step + 1
      const complete = nextStep >= executableSteps(steps).length
      await supabase
        .from('follow_up_enrollments')
        .update({ current_step: nextStep, status: complete ? 'completed' : 'active', last_step_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', e.id)
      if (complete) {
        summary.completed++

        // Cadence exhausted with no reply → drop from Following Up to Nurturing.
        // Stage-move only: no send, unaffected by MESSAGING_DRY_RUN.
        const state = classifyContactedState(
          {
            last_contacted_at: lead.last_contacted_at ?? null,
            last_responded_at: lead.last_responded_at ?? null,
            total_messages_received: lead.total_messages_received ?? null,
          },
          nowMs
        )
        if (state !== 'engaged') {
          const { data: contactedStage } = await supabase
            .from('pipeline_stages')
            .select('id')
            .eq('organization_id', lead.organization_id)
            .eq('slug', 'contacted')
            .maybeSingle()
          if (contactedStage?.id && lead.stage_id === contactedStage.id) {
            const nurturingStageId = await ensureNurturingStageId(supabase, lead.organization_id)
            if (nurturingStageId) {
              await supabase.from('leads').update({ stage_id: nurturingStageId }).eq('id', lead.id)
            }
          }
        }
      }
    } catch (err) {
      // Isolate per-enrollment failures — one bad lead must not abort the batch.
      summary.errors++
      console.warn('[follow-up-sequences] enrollment failed', e.id, err instanceof Error ? err.message : err)
    }
  }

  return NextResponse.json(summary)
}
