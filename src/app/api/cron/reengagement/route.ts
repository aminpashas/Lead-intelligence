/**
 * Autonomous re-engagement (Phase 3).
 *
 * Fires the Closer's cold-lead ladder on a schedule: for each org with the
 * `autonomous_reengagement` flag on, finds stalled-but-consented leads whose next
 * touch is due and sends a stage-appropriate message. Compliance is delegated to
 * sendSMSToLead (consent gate + TCPA quiet hours), so this loop can't send to a
 * lead who hasn't granted SMS or is in quiet hours. The terminal stage
 * (graceful_release) hands the lead to a human via an escalation instead of
 * auto-texting, and pauses the ladder.
 *
 * Schedule: hourly (vercel.json). Heartbeats via withCron.
 */

import { withCron } from '@/lib/cron/with-cron'
import { decryptField } from '@/lib/encryption'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { reengagementStep, buildReengagementMessage } from '@/lib/nurture/ladder'

const PER_ORG_CAP = 50
const DAY_MS = 24 * 60 * 60 * 1000
// Statuses worth re-engaging: in the funnel but stalled. Terminal/again-dead
// statuses (won, lost, disqualified, dormant, no_show handled elsewhere) are excluded.
const ACTIVE_STATUSES = [
  'contacted',
  'qualified',
  'consultation_completed',
  'treatment_presented',
  'financing',
  'contract_sent',
]

export const POST = withCron('reengagement', async ({ supabase }) => {
  const { data: orgs } = await supabase
    .from('organizations')
    .select('id, name, feature_flags')

  type OrgRow = { id: string; name: string | null; feature_flags: Record<string, boolean> | null }
  const enabled = ((orgs ?? []) as OrgRow[]).filter(
    (o) => o.feature_flags?.autonomous_reengagement === true
  )
  if (enabled.length === 0) {
    return { status: 'skipped', items: 0, data: { reason: 'no_orgs_enabled' } }
  }

  const now = Date.now()
  const nowIso = new Date(now).toISOString()
  const idleCutoff = new Date(now - 7 * DAY_MS).toISOString()
  let touched = 0
  let escalated = 0

  for (const org of enabled) {
    const { data: leads } = await supabase
      .from('leads')
      .select('id, first_name, phone_formatted, last_contacted_at, status')
      .eq('organization_id', org.id)
      // Consent assumed — reach any lead that hasn't opted out of SMS (DND).
      .eq('sms_opt_out', false)
      .in('status', ACTIVE_STATUSES)
      .lt('last_contacted_at', idleCutoff)
      .not('last_contacted_at', 'is', null)
      .order('last_contacted_at', { ascending: true })
      .limit(200)

    let orgTouched = 0
    for (const lead of leads ?? []) {
      if (orgTouched >= PER_ORG_CAP) break

      // Ladder cursor — skip paused or not-yet-due.
      const { data: state } = await supabase
        .from('lead_nurture_state')
        .select('attempts, next_action_at, paused')
        .eq('lead_id', lead.id)
        .maybeSingle()
      if (state?.paused) continue
      if (state?.next_action_at && new Date(state.next_action_at).getTime() > now) continue

      const days = Math.floor((now - new Date(lead.last_contacted_at as string).getTime()) / DAY_MS)
      const step = reengagementStep(days)
      if (!step) continue

      // Terminal: hand to a human, stop the ladder.
      if (step.terminal) {
        await supabase.from('escalations').insert({
          organization_id: org.id,
          lead_id: lead.id,
          reason: 'max_attempts_reached',
          ai_notes: `Re-engagement ladder reached graceful_release after ${days}d of silence. Handing to a human.`,
          status: 'pending',
        })
        await supabase.from('lead_nurture_state').upsert(
          {
            lead_id: lead.id,
            organization_id: org.id,
            current_stage: step.stage,
            attempts: (state?.attempts ?? 0) + 1,
            last_touch_at: nowIso,
            next_action_at: null,
            paused: true,
            updated_at: nowIso,
          },
          { onConflict: 'lead_id' }
        )
        escalated++
        continue
      }

      const phone = lead.phone_formatted
        ? decryptField(lead.phone_formatted) || lead.phone_formatted
        : null
      if (!phone) continue

      const body = buildReengagementMessage(step.stage, {
        firstName: lead.first_name,
        orgName: org.name,
      })

      const res = await sendSMSToLead({
        supabase,
        leadId: lead.id,
        to: phone,
        body,
        caller: 'reengagement',
        aiGenerated: true,
      })

      if (res.sent) {
        orgTouched++
        touched++
        await supabase.from('lead_nurture_state').upsert(
          {
            lead_id: lead.id,
            organization_id: org.id,
            current_stage: step.stage,
            attempts: (state?.attempts ?? 0) + 1,
            last_touch_at: nowIso,
            next_action_at: new Date(now + step.nextDelayDays * DAY_MS).toISOString(),
            paused: false,
            updated_at: nowIso,
          },
          { onConflict: 'lead_id' }
        )
      } else if (res.reason === 'quiet_hours') {
        // Not a failure — just too early/late. Re-check in a few hours without
        // advancing the ladder stage, so we don't burn the touch.
        await supabase.from('lead_nurture_state').upsert(
          {
            lead_id: lead.id,
            organization_id: org.id,
            next_action_at: new Date(now + 3 * 60 * 60 * 1000).toISOString(),
            paused: false,
            updated_at: nowIso,
          },
          { onConflict: 'lead_id' }
        )
      }
      // Any other reason (consent revoked, compliance) — leave the lead alone;
      // the consent gate already logged it. No state write so it isn't retried hard.
    }
  }

  return { items: touched, data: { touched, escalated, orgs_enabled: enabled.length } }
})

export const GET = POST
