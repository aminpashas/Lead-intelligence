/**
 * Post-Consult Funding Nurture — campaign definition + idempotent seeding.
 *
 * When a patient ATTENDS a consult but hasn't signed, they're enrolled here (via
 * the `consult_completed` trigger event fired from the appointments hook). The
 * sequence runs ~75 days, tapering, and drives five outcomes:
 *   1. Self-funding   — HSA/FSA + savings + down-payment budgeting
 *   2. Friends&family — recruit a CO-SIGNER / referred applicant (shareable link)
 *   3. Engagement     — keep them warm without fatigue
 *   4. Value          — connect treatment to their real pain points/desires
 *   5. Alt financing  — multi-lender waterfall, re-apply, longer term / lower down
 *
 * Each AI step is composed by the CLOSER agent (objection-aware: it reads the
 * patient's real objections + financing state and applies the pricing-integrity
 * guardrail), then gated by autopilot and sent by the campaign executor. See
 * src/lib/campaigns/nurture-executor.ts for the send path.
 *
 * This TS module is the single source of truth for the campaign content; it is
 * seeded per-org idempotently (keyed on campaigns.metadata->>'system_key'), so
 * there's no duplicated SQL to drift.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** Stable key used to find/upsert this system campaign per org. */
export const POST_CONSULT_NURTURE_KEY = 'post_consult_funding_nurture'
export const POST_CONSULT_NURTURE_VERSION = 1

/** Statuses that mean the case is converting or dead — exit the nurture. */
export const NURTURE_EXIT_STATUSES = [
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
  if_status_in: [...NURTURE_EXIT_STATUSES],
} as const

/** Only send this step while financing is NOT yet secured (interpreted by the nurture executor). */
const IF_FINANCING_NOT_APPROVED = { if_financing_not_approved: true } as const

export type NurtureStepSeed = {
  step_number: number
  name: string
  channel: 'sms' | 'email'
  /** Delay from the previous step (or from enrollment for step 1), in minutes. */
  delay_minutes: number
  subject?: string
  /** Fallback copy used only if AI composition fails (or when ai_personalize is false). */
  body_template: string
  ai_personalize: boolean
  send_condition?: Record<string, unknown>
  metadata: {
    /** 'closer' → objection-aware AI composition; omitted → fixed template send. */
    ai_generator?: 'closer'
    /** Steers the closer's proactive touch. */
    nurture_goal?: string
    /** Step 6: append a forwardable financing application link (co-signer path). */
    append_financing_link?: boolean
  }
}

const DAY = 1440 // minutes

export const POST_CONSULT_NURTURE_STEPS: NurtureStepSeed[] = [
  {
    step_number: 1,
    name: 'Warm recap + open door',
    channel: 'sms',
    delay_minutes: 2 * DAY, // Day 2 — after the funnel's day-of thank-you, before nurture ramps
    ai_personalize: false,
    body_template:
      "Hi {{first_name}}, it was great having you in at {{practice_name}}! A new smile is a big decision, and I'm here to help with any questions — including making the payment side feel doable. What's the main thing on your mind after your visit?",
    metadata: {},
  },
  {
    step_number: 2,
    name: 'Value — connect to their why',
    channel: 'email',
    delay_minutes: 1 * DAY, // Day 3
    ai_personalize: true,
    subject: 'Following up on your visit, {{first_name}}',
    body_template:
      "Hi {{first_name}}, it was a pleasure meeting you. I've been thinking about what you shared and I'm confident we can help you get there. Reply anytime with questions — I'm here for you.",
    metadata: {
      ai_generator: 'closer',
      nurture_goal:
        'Reinforce the value of their consultation by connecting the treatment plan to THIS patient\'s specific pain points and desires (from their psychology profile). Warm, no pressure. Invite one question.',
    },
  },
  {
    step_number: 3,
    name: 'Objection handling (personality-matched)',
    channel: 'sms',
    delay_minutes: 2 * DAY, // Day 5
    ai_personalize: true,
    body_template:
      "Hi {{first_name}}, checking in — a lot of patients have a question or two after they sleep on it. What's the one thing holding you back right now? I'd love to help work through it.",
    metadata: {
      ai_generator: 'closer',
      nurture_goal:
        "Surface and address the patient's TOP unresolved objection using the approach matched to their personality (cost → lifetime-value math, fear → sedation/recovery, timing → bone loss, trust → social proof). One objection only. Genuinely acknowledge it first.",
    },
  },
  {
    step_number: 4,
    name: 'Self-funding budget plan',
    channel: 'email',
    delay_minutes: 3 * DAY, // Day 8
    ai_personalize: true,
    send_condition: IF_FINANCING_NOT_APPROVED,
    subject: 'A simple way to make your treatment fit your budget',
    body_template:
      "Hi {{first_name}}, most patients fund treatment from a few sources combined — insurance, HSA/FSA, a little savings, and financing for the rest. I'd be glad to help map out what that looks like for you. Want me to put together a simple plan?",
    metadata: {
      ai_generator: 'closer',
      nurture_goal:
        'Act as their financial coach. Present a MULTI-SOURCE self-funding plan — dental insurance annual max, HSA/FSA pre-tax dollars, a tax refund as a down payment, and financing for the balance. Encouraging, concrete about the sources, but never invent specific dollar figures unless real financing data exists.',
    },
  },
  {
    step_number: 5,
    name: 'Value / social proof',
    channel: 'sms',
    delay_minutes: 4 * DAY, // Day 12
    ai_personalize: true,
    body_template:
      "Hi {{first_name}}, I was just thinking of you — we've helped so many people in a similar spot finally stop hiding their smile. Whenever you're ready to talk next steps, I'm here.",
    metadata: {
      ai_generator: 'closer',
      nurture_goal:
        'Share a brief, relevant patient-success angle that mirrors THIS patient\'s situation (describe it in words — you cannot attach media on this touch). Build value and hope, low pressure.',
    },
  },
  {
    step_number: 6,
    name: 'Co-signer / friends & family',
    channel: 'sms',
    delay_minutes: 6 * DAY, // Day 18
    ai_personalize: true,
    send_condition: IF_FINANCING_NOT_APPROVED,
    body_template:
      "Hi {{first_name}}, quick idea: many patients strengthen their approval by applying with a co-signer — a spouse, parent, or close friend with solid credit. If that's an option for you, I can send a secure link you (or they) can use to apply. Want me to send it over?",
    metadata: {
      ai_generator: 'closer',
      append_financing_link: true,
      nurture_goal:
        "Introduce the co-signer / family-applicant option warmly: applying WITH a co-signer (spouse, parent, adult child, close friend with stronger credit) often improves approval and lowers the monthly. Offer to send a secure application link they can forward to that person. If a financing link is provided below your message, invite them to use or share it. Normalize it — plenty of families do this together.",
    },
  },
  {
    step_number: 7,
    name: 'Alternative financing',
    channel: 'email',
    delay_minutes: 7 * DAY, // Day 25
    ai_personalize: true,
    send_condition: IF_FINANCING_NOT_APPROVED,
    subject: "More ways to make this work, {{first_name}}",
    body_template:
      "Hi {{first_name}}, if financing hasn't come together yet, don't count it out — we work with several lenders, and each looks at things differently. We can also stretch the term to lower the monthly, or start with a smaller down payment. Want me to explore a few options for you?",
    metadata: {
      ai_generator: 'closer',
      nurture_goal:
        'Present alternative financing paths WITHOUT discouragement: multiple lenders (each with different criteria), a longer term to lower the monthly, a smaller down payment, an in-house plan, or improving credit and re-applying in 60–90 days. If they were denied by a lender, reassure and pivot to the next option. Use the patient\'s real financing context (denied lenders, tier) if present.',
    },
  },
  {
    step_number: 8,
    name: 'Cost of waiting + gentle incentive',
    channel: 'sms',
    delay_minutes: 7 * DAY, // Day 32
    ai_personalize: true,
    body_template:
      "Hi {{first_name}}, no rush at all — I just don't want the wait to make things harder down the road. If it helps, I can check whether we have anything special available this month. Want me to look?",
    metadata: {
      ai_generator: 'closer',
      nurture_goal:
        'Gently frame the real cost of waiting (bone loss over time is a genuine medical factor, not a scare tactic) and offer to check for any legitimate current incentive. Warm, honest, never fabricate scarcity or deadlines.',
    },
  },
  {
    step_number: 9,
    name: 'Your options recap',
    channel: 'email',
    delay_minutes: 8 * DAY, // Day 40
    ai_personalize: true,
    subject: 'Your options, all in one place',
    body_template:
      "Hi {{first_name}}, I wanted to pull your options together in one place: self-pay budgeting, applying with a co-signer, and a few different financing paths. Whenever you're ready, we can pick the one that fits best. Just reply and we'll take it from there.",
    metadata: {
      ai_generator: 'closer',
      nurture_goal:
        'Give a clear, reassuring recap of ALL the ways forward — self-pay budgeting (insurance + HSA/FSA + savings), applying with a co-signer, and alternative financing — and invite them to pick one. Confident and supportive, one clear next step.',
    },
  },
  {
    step_number: 10,
    name: 'Empathetic check-in',
    channel: 'sms',
    delay_minutes: 15 * DAY, // Day 55
    ai_personalize: true,
    body_template:
      "Hi {{first_name}}, just checking in — no agenda, just wanted you to know we're still here whenever the timing feels right. How are you doing?",
    metadata: {
      ai_generator: 'closer',
      nurture_goal:
        'A genuine, no-pressure check-in that removes all sales pressure. Just human warmth and an open door. This often brings people back precisely because it isn\'t a pitch.',
    },
  },
  {
    step_number: 11,
    name: 'Door-always-open (final)',
    channel: 'email',
    delay_minutes: 20 * DAY, // Day 75
    ai_personalize: true,
    subject: "Whenever you're ready, {{first_name}}",
    body_template:
      "Hi {{first_name}}, I won't keep filling your inbox — I just want you to know your treatment plan and consultation don't expire. Whenever you're ready, even months from now, reply to this and I'll personally help you pick up right where we left off. Rooting for you.",
    metadata: {
      ai_generator: 'closer',
      nurture_goal:
        'A warm graceful-release message: reassure that their plan and consultation never expire and the door is always open. No pressure. This is the last scheduled touch before they hand off to long-term winback.',
    },
  },
]

/** Business-hours secondary filter (authoritative TCPA check is the autopilot gate). */
const SEND_WINDOW = { start_hour: 9, end_hour: 19, timezone: 'America/New_York', days: [1, 2, 3, 4, 5, 6] }

/**
 * Find this org's post-consult nurture campaign, if it's been seeded.
 */
export async function getPostConsultNurtureCampaignId(
  supabase: SupabaseClient,
  organizationId: string
): Promise<string | null> {
  const { data } = await supabase
    .from('campaigns')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('type', 'trigger')
    .eq('metadata->>system_key', POST_CONSULT_NURTURE_KEY)
    .limit(1)
    .maybeSingle<{ id: string }>()
  return data?.id ?? null
}

/**
 * Idempotently seed the post-consult funding nurture (campaign + steps) for an
 * org. Safe to call repeatedly — returns the existing campaign id if present.
 * Called lazily from the appointment-completion hook so both new and existing
 * orgs get it exactly when first needed.
 */
export async function seedPostConsultNurture(
  supabase: SupabaseClient,
  organizationId: string
): Promise<string | null> {
  const existing = await getPostConsultNurtureCampaignId(supabase, organizationId)
  if (existing) return existing

  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .insert({
      organization_id: organizationId,
      name: 'Post-Consult Funding Nurture',
      description:
        'Objection-aware funding nurture for patients who attended a consult but haven\'t signed. Drives self-pay budgeting, co-signer / family financing, value-building, and alternative financing over ~75 days. Auto-enrolls on the consult_completed trigger.',
      type: 'trigger',
      channel: 'multi',
      status: 'active',
      target_criteria: { trigger_event: 'consult_completed', has_phone: true, has_email: true },
      send_window: SEND_WINDOW,
      metadata: { system_key: POST_CONSULT_NURTURE_KEY, version: POST_CONSULT_NURTURE_VERSION },
    })
    .select('id')
    .single<{ id: string }>()

  if (campaignError || !campaign) {
    // A concurrent call may have created it — re-check before giving up.
    return await getPostConsultNurtureCampaignId(supabase, organizationId)
  }

  const stepRows = POST_CONSULT_NURTURE_STEPS.map((s) => ({
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
