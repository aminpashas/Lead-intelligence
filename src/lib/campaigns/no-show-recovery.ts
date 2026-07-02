/**
 * No-Show Recovery — 3-touch rebooking sequence.
 *
 * Enrolls on the `appointment_no_show` trigger (fired when staff or the EHR
 * marks a no-show). A reply or a new booking (status → consultation_scheduled)
 * exits the sequence. Seeded lazily per org like the post-consult nurture so
 * there's no migration-managed campaign SQL to drift.
 *
 * NOTE: steps 2–3 carry `ai_generator: 'closer'` metadata, but the closer-routing
 * nurture executor lives on feat/online-booking-ehr and hasn't merged — until it
 * does, those steps send via the generic ai_personalize path (still AI-composed,
 * just not objection-aware). No reseed needed when it lands.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { NurtureStepSeed } from './post-consult-nurture'

export type { NurtureStepSeed } from './post-consult-nurture'

/** Stable key used to find/upsert this system campaign per org. */
export const NO_SHOW_RECOVERY_KEY = 'no_show_recovery'
export const NO_SHOW_RECOVERY_VERSION = 1

/** Rebooked, converting, or dead — stop chasing. */
export const NO_SHOW_RECOVERY_EXIT_STATUSES = [
  'consultation_scheduled',
  'consultation_completed',
  'contract_sent',
  'contract_signed',
  'scheduled',
  'in_treatment',
  'completed',
  'lost',
  'disqualified',
] as const

/**
 * Shared exit condition. Dual-shaped so BOTH code paths honor it:
 *  - executor.evaluateExitCondition reads `if_replied` / `if_status_in`
 *  - enrollments.exitCampaignsOnReply reads `type === 'if_replied'`
 */
const EXIT_CONDITION = {
  type: 'if_replied',
  if_replied: true,
  if_status_in: [...NO_SHOW_RECOVERY_EXIT_STATUSES],
} as const

// post-consult-nurture.ts merged to main — the shared seed type is re-exported
// from the top of this file for existing importers.

const DAY = 1440 // minutes

export const NO_SHOW_RECOVERY_STEPS: NurtureStepSeed[] = [
  {
    step_number: 1,
    name: 'Same-day — we missed you',
    channel: 'sms',
    delay_minutes: 30,
    ai_personalize: false,
    body_template:
      "Hi {{first_name}}, we missed you at {{practice_name}} today! Life happens — want to grab another time? Reply here and we'll get you rescheduled in seconds.",
    metadata: {},
  },
  {
    step_number: 2,
    name: 'Day 3 — remove the blocker',
    channel: 'sms',
    delay_minutes: 3 * DAY - 30,
    ai_personalize: true,
    body_template:
      "Hi {{first_name}}, just checking in — sometimes the timing isn't right, and sometimes there's a question holding things up. Either way I'd love to help. What would make it easier to come in?",
    metadata: {
      ai_generator: 'closer',
      nurture_goal:
        'Warmly re-open after a missed consultation. Acknowledge that missing an appointment is normal, gently surface whatever blocked them (schedule, nerves, cost), and invite a reschedule. No guilt, no pressure, one question.',
    },
  },
  {
    step_number: 3,
    name: 'Day 10 — open door',
    channel: 'email',
    delay_minutes: 7 * DAY,
    ai_personalize: true,
    subject: 'Your consultation spot is still here, {{first_name}}',
    body_template:
      "Hi {{first_name}}, we'd still love to see you. Whenever the timing works, reply to this email or give us a call and we'll find a time that fits your schedule.",
    metadata: {
      ai_generator: 'closer',
      nurture_goal:
        'Final soft invitation to rebook after a no-show. Low pressure, keep the door open, remind them why they reached out in the first place if their profile shows a motivation.',
    },
  },
]

/** Business-hours secondary filter (authoritative TCPA check is the autopilot gate). */
const SEND_WINDOW = { start_hour: 9, end_hour: 19, timezone: 'America/New_York', days: [1, 2, 3, 4, 5, 6] }

/**
 * Find this org's no-show recovery campaign, if it's been seeded.
 */
export async function getNoShowRecoveryCampaignId(
  supabase: SupabaseClient,
  organizationId: string
): Promise<string | null> {
  const { data } = await supabase
    .from('campaigns')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('type', 'trigger')
    .eq('metadata->>system_key', NO_SHOW_RECOVERY_KEY)
    .limit(1)
    .maybeSingle<{ id: string }>()
  return data?.id ?? null
}

/**
 * Idempotently seed the no-show recovery campaign (campaign + steps) for an
 * org. Safe to call repeatedly — returns the existing campaign id if present.
 * Same rollback-on-partial-failure idiom as seedPostConsultNurture.
 */
export async function seedNoShowRecovery(
  supabase: SupabaseClient,
  organizationId: string
): Promise<string | null> {
  const existing = await getNoShowRecoveryCampaignId(supabase, organizationId)
  if (existing) return existing

  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .insert({
      organization_id: organizationId,
      name: 'No-Show Recovery',
      description:
        'Rebooking sequence for patients who no-showed a consultation: same-day "we missed you" SMS, a day-3 objection-aware check-in, and a day-10 open-door email. Auto-enrolls on the appointment_no_show trigger; exits on reply or rebooking.',
      type: 'trigger',
      channel: 'multi',
      status: 'active',
      target_criteria: { trigger_event: 'appointment_no_show', has_phone: true },
      send_window: SEND_WINDOW,
      metadata: { system_key: NO_SHOW_RECOVERY_KEY, version: NO_SHOW_RECOVERY_VERSION },
    })
    .select('id')
    .single<{ id: string }>()

  if (campaignError || !campaign) {
    // A concurrent call may have created it — re-check before giving up.
    return await getNoShowRecoveryCampaignId(supabase, organizationId)
  }

  const stepRows = NO_SHOW_RECOVERY_STEPS.map((s) => ({
    campaign_id: campaign.id,
    organization_id: organizationId,
    step_number: s.step_number,
    name: s.name,
    channel: s.channel,
    delay_minutes: s.delay_minutes,
    delay_type: 'after_previous',
    subject: s.subject ?? null,
    body_template: s.body_template,
    ai_personalize: s.ai_personalize,
    send_condition: s.send_condition ?? null,
    exit_condition: EXIT_CONDITION,
    metadata: s.metadata,
  }))

  const { error: stepsError } = await supabase.from('campaign_steps').insert(stepRows)
  if (stepsError) {
    // Roll back the empty campaign so a retry can re-seed cleanly.
    await supabase.from('campaigns').delete().eq('id', campaign.id)
    return null
  }

  return campaign.id
}
