/**
 * Stage transition automations — defines what happens when a lead
 * moves between pipeline stages. These are the "rules engine" that
 * drives the CRM's automated engagement.
 */

export type StageTransitionRule = {
  id: string
  name: string
  description: string
  fromStage: string | null  // null = any stage
  toStage: string
  conditions?: TransitionCondition[]
  actions: TransitionAction[]
  enabled: boolean
}

export type TransitionCondition = {
  field: string
  operator: 'equals' | 'not_equals' | 'in' | 'gt' | 'lt' | 'is_null' | 'not_null'
  value: unknown
}

export type TransitionAction = {
  type: 'send_sms' | 'send_email' | 'create_task' | 'enroll_campaign' | 'update_status' | 'notify_team' | 'ai_score' | 'schedule_followup' | 'update_field'
  delay_minutes: number
  config: Record<string, unknown>
}

// ════════════════════════════════════════════════════════════════
// DEFAULT STAGE TRANSITION RULES
// ════════════════════════════════════════════════════════════════

export const DEFAULT_TRANSITION_RULES: StageTransitionRule[] = [

  // ── New Lead Entry ────────────────────────────────────────
  {
    id: 'new-lead-instant-response',
    name: 'Instant Lead Response',
    description: 'When a new lead is created, score with AI and send welcome SMS within 2 minutes',
    fromStage: null,
    toStage: 'new',
    actions: [
      {
        type: 'ai_score',
        delay_minutes: 0,
        config: { reason: 'New lead auto-score' },
      },
      {
        type: 'send_sms',
        delay_minutes: 2,
        config: {
          template: 'welcome_sms',
          ai_personalize: false,
        },
      },
      {
        type: 'notify_team',
        delay_minutes: 0,
        config: {
          message: 'New lead arrived! Speed to contact is critical.',
          priority: 'high',
        },
      },
      {
        type: 'create_task',
        delay_minutes: 15,
        config: {
          title: 'Call new lead — {{first_name}} {{last_name}}',
          description: 'Call within 15 minutes of lead creation. Speed to lead wins.',
          assignTo: 'assigned_or_owner',
          priority: 'urgent',
        },
      },
      {
        type: 'enroll_campaign',
        delay_minutes: 60,
        config: {
          campaign_template: 'new-lead-nurture',
          condition: 'if_no_response',
        },
      },
    ],
    enabled: true,
  },

  // ── New → Contacted ───────────────────────────────────────
  {
    id: 'new-to-contacted',
    name: 'First Contact Made',
    description: 'Lead responded to outreach. Begin qualification process.',
    fromStage: 'new',
    toStage: 'contacted',
    actions: [
      {
        type: 'update_status',
        delay_minutes: 0,
        config: { status: 'contacted' },
      },
      {
        type: 'create_task',
        delay_minutes: 0,
        config: {
          title: 'Qualify lead — {{first_name}} {{last_name}}',
          description: 'Review conversation and AI score. Determine if lead is a candidate. Ask qualifying questions.',
          assignTo: 'assigned',
          priority: 'high',
        },
      },
    ],
    enabled: true,
  },

  // ── Contacted → Qualified ─────────────────────────────────
  {
    id: 'contacted-to-qualified',
    name: 'Lead Qualified',
    description: 'Lead is confirmed as a candidate. Push hard to book consultation.',
    fromStage: 'contacted',
    toStage: 'qualified',
    actions: [
      {
        type: 'update_status',
        delay_minutes: 0,
        config: { status: 'qualified' },
      },
      {
        type: 'notify_team',
        delay_minutes: 0,
        config: {
          message: '🔥 Lead qualified! Book consultation ASAP.',
          priority: 'urgent',
        },
      },
      {
        type: 'send_sms',
        delay_minutes: 5,
        config: {
          template: 'qualification_congrats',
          ai_personalize: true,
        },
      },
      {
        type: 'create_task',
        delay_minutes: 30,
        config: {
          title: 'Book consultation — {{first_name}} {{last_name}}',
          description: 'Call to schedule. Use assumptive close: "I have openings Tuesday and Thursday — which works better?"',
          assignTo: 'assigned',
          priority: 'urgent',
        },
      },
    ],
    enabled: true,
  },

  // ── Qualified → Consultation Scheduled ────────────────────
  {
    id: 'qualified-to-consult-scheduled',
    name: 'Consultation Booked',
    description: 'Consultation is booked. Begin no-show prevention sequence.',
    fromStage: 'qualified',
    toStage: 'consultation-scheduled',
    actions: [
      {
        type: 'update_status',
        delay_minutes: 0,
        config: { status: 'consultation_scheduled' },
      },
      {
        type: 'send_sms',
        delay_minutes: 5,
        config: {
          template: 'consultation_confirmation',
          ai_personalize: false,
        },
      },
      {
        type: 'send_email',
        delay_minutes: 10,
        config: {
          template: 'consultation_details',
          subject: 'Your consultation is confirmed! Here\'s what to expect',
        },
      },
      {
        type: 'enroll_campaign',
        delay_minutes: 30,
        config: {
          campaign_template: 'pre-consultation-warmup',
        },
      },
    ],
    enabled: true,
  },

  // ── Consultation No-Show ──────────────────────────────────
  {
    id: 'consult-no-show',
    name: 'Consultation No-Show',
    description: 'Lead missed their consultation. Begin re-engagement immediately.',
    fromStage: 'consultation-scheduled',
    toStage: 'consultation-scheduled', // Stay in stage but mark as no-show
    conditions: [
      { field: 'status', operator: 'equals', value: 'no_show' },
    ],
    actions: [
      {
        type: 'send_sms',
        delay_minutes: 30,
        config: {
          template: 'no_show_gentle',
          ai_personalize: false,
        },
      },
      {
        type: 'enroll_campaign',
        delay_minutes: 60,
        config: {
          campaign_template: 'no-show-reengagement',
        },
      },
      {
        type: 'notify_team',
        delay_minutes: 0,
        config: {
          message: '⚠️ No-show! Lead missed consultation. Re-engagement triggered.',
          priority: 'high',
        },
      },
      {
        type: 'create_task',
        delay_minutes: 120,
        config: {
          title: 'Call no-show — {{first_name}} {{last_name}}',
          description: 'Personal call to reschedule. Be empathetic, not accusatory. "Life happens — let\'s find a better time."',
          assignTo: 'assigned',
          priority: 'urgent',
        },
      },
    ],
    enabled: true,
  },

  // ── Consultation Completed ────────────────────────────────
  {
    id: 'consult-completed',
    name: 'Consultation Completed',
    description: 'Patient attended consultation. Begin aggressive follow-up to close.',
    fromStage: 'consultation-scheduled',
    toStage: 'consultation-completed',
    actions: [
      {
        type: 'update_status',
        delay_minutes: 0,
        config: { status: 'consultation_completed' },
      },
      {
        type: 'send_sms',
        delay_minutes: 120,
        config: {
          template: 'post_consultation_thankyou',
          ai_personalize: true,
        },
      },
      {
        type: 'create_task',
        delay_minutes: 1440, // Next day
        config: {
          title: 'Post-consult follow-up call — {{first_name}} {{last_name}}',
          description: 'Call next morning. "How are you feeling about what we discussed? Any questions?"',
          assignTo: 'assigned',
          priority: 'urgent',
        },
      },
      {
        type: 'enroll_campaign',
        delay_minutes: 180,
        config: {
          campaign_template: 'post-consultation-close',
        },
      },
    ],
    enabled: true,
  },

  // ── Treatment Presented ───────────────────────────────────
  {
    id: 'treatment-presented',
    name: 'Treatment Plan Presented',
    description: 'Treatment plan has been presented with pricing. Follow up on objections.',
    fromStage: 'consultation-completed',
    toStage: 'treatment-presented',
    actions: [
      {
        type: 'update_status',
        delay_minutes: 0,
        config: { status: 'treatment_presented' },
      },
      {
        type: 'send_email',
        delay_minutes: 30,
        config: {
          template: 'treatment_plan_summary',
          subject: '{{first_name}}, your personalized treatment plan',
        },
      },
      {
        type: 'create_task',
        delay_minutes: 2880, // 2 days
        config: {
          title: 'Follow up on treatment plan — {{first_name}} {{last_name}}',
          description: 'Check in on decision. Address any new questions or concerns.',
          assignTo: 'assigned',
          priority: 'high',
        },
      },
    ],
    enabled: true,
  },

  // ── Financing ─────────────────────────────────────────────
  {
    id: 'to-financing',
    name: 'Financing Application',
    description: 'Lead is applying for financing. Guide them through the process.',
    fromStage: 'treatment-presented',
    toStage: 'financing',
    actions: [
      {
        type: 'update_status',
        delay_minutes: 0,
        config: { status: 'financing' },
      },
      {
        type: 'send_sms',
        delay_minutes: 5,
        config: {
          template: 'financing_guide',
          ai_personalize: false,
        },
      },
      {
        type: 'create_task',
        delay_minutes: 0,
        config: {
          title: 'Send financing application — {{first_name}} {{last_name}}',
          description: 'Send application link. Offer to walk through it together on the phone.',
          assignTo: 'assigned',
          priority: 'high',
        },
      },
    ],
    enabled: true,
  },

  // ── Contract Signed ───────────────────────────────────────
  {
    id: 'contract-signed',
    name: 'Contract Signed',
    description: 'Patient committed! Schedule treatment and begin pre-op sequence.',
    fromStage: 'financing',
    toStage: 'contract-signed',
    actions: [
      {
        type: 'update_status',
        delay_minutes: 0,
        config: { status: 'contract_signed' },
      },
      {
        type: 'send_sms',
        delay_minutes: 5,
        config: {
          template: 'contract_celebration',
          ai_personalize: false,
        },
      },
      {
        type: 'send_email',
        delay_minutes: 30,
        config: {
          template: 'welcome_packet',
          subject: 'Welcome to your new smile journey, {{first_name}}! 🎉',
        },
      },
      {
        type: 'create_task',
        delay_minutes: 60,
        config: {
          title: 'Schedule treatment date — {{first_name}} {{last_name}}',
          description: 'Call to schedule treatment. Order materials and prep lab.',
          assignTo: 'assigned',
          priority: 'high',
        },
      },
      {
        type: 'notify_team',
        delay_minutes: 0,
        config: {
          message: '🎉 New case closed! Contract signed.',
          priority: 'high',
        },
      },
    ],
    enabled: true,
  },

  // ── Scheduled for Treatment ───────────────────────────────
  {
    id: 'scheduled-treatment',
    name: 'Treatment Scheduled',
    description: 'Treatment date is set. Pre-op countdown begins.',
    fromStage: 'contract-signed',
    toStage: 'scheduled',
    actions: [
      {
        type: 'update_status',
        delay_minutes: 0,
        config: { status: 'scheduled' },
      },
      {
        type: 'send_email',
        delay_minutes: 0,
        config: {
          template: 'preop_checklist',
          subject: 'Your pre-procedure checklist — please review',
        },
      },
      {
        type: 'enroll_campaign',
        delay_minutes: 30,
        config: {
          campaign_template: 'pre-treatment-countdown',
        },
      },
    ],
    enabled: true,
  },

  // ── Treatment Completed ───────────────────────────────────
  {
    id: 'treatment-completed',
    name: 'Treatment Completed',
    description: 'Procedure done! Begin aftercare and referral engine.',
    fromStage: 'scheduled',
    toStage: 'completed',
    actions: [
      {
        type: 'update_status',
        delay_minutes: 0,
        config: { status: 'completed' },
      },
      {
        type: 'send_sms',
        delay_minutes: 1440,
        config: {
          template: 'day_after_checkin',
          ai_personalize: true,
        },
      },
      {
        type: 'enroll_campaign',
        delay_minutes: 4320,
        config: {
          campaign_template: 'post-treatment-care',
        },
      },
      {
        type: 'schedule_followup',
        delay_minutes: 10080,
        config: {
          type: 'follow_up',
          days_out: 7,
        },
      },
    ],
    enabled: true,
  },

  // ── Lead Lost ─────────────────────────────────────────────
  {
    id: 'lead-lost',
    name: 'Lead Lost',
    description: 'Lead is lost. Log reason and enter long-term winback sequence.',
    fromStage: null,
    toStage: 'lost',
    actions: [
      {
        type: 'update_status',
        delay_minutes: 0,
        config: { status: 'lost' },
      },
      {
        type: 'create_task',
        delay_minutes: 0,
        config: {
          title: 'Document lost reason — {{first_name}} {{last_name}}',
          description: 'Log why this lead was lost. This data improves our process.',
          assignTo: 'assigned',
          priority: 'medium',
        },
      },
      {
        type: 'send_email',
        delay_minutes: 1440,
        config: {
          template: 'graceful_exit',
          subject: 'The door is always open, {{first_name}}',
        },
      },
      {
        type: 'enroll_campaign',
        delay_minutes: 43200, // 30 days
        config: {
          campaign_template: 'winback',
        },
      },
    ],
    enabled: true,
  },
]

// ════════════════════════════════════════════════════════════════
// ADDITIONAL CAMPAIGN TEMPLATES FOR STAGE AUTOMATIONS
// ════════════════════════════════════════════════════════════════

export const STAGE_CAMPAIGN_TEMPLATES = [
  {
    id: 'pre-consultation-warmup',
    name: 'Pre-Consultation Warm-Up',
    description: 'Builds excitement and prevents no-shows between booking and consultation date.',
    steps: 4,
    duration: 'Until consultation date',
    channel: 'multi' as const,
    target: 'consultation-scheduled leads',
  },
  {
    id: 'post-consultation-close',
    name: 'Post-Consultation Close',
    description: 'Aggressive follow-up sequence to close patients after consultation.',
    steps: 6,
    duration: '7 days',
    channel: 'multi' as const,
    target: 'consultation-completed leads who didn\'t close same-day',
  },
  {
    id: 'financing-assistance',
    name: 'Financing Assistance',
    description: 'Guides leads through financing application with helpful reminders.',
    steps: 4,
    duration: '5 days',
    channel: 'multi' as const,
    target: 'leads in financing stage',
  },
  {
    id: 'pre-treatment-countdown',
    name: 'Pre-Treatment Countdown',
    description: 'Countdown to treatment day with pre-op instructions and excitement.',
    steps: 5,
    duration: 'Until treatment date',
    channel: 'multi' as const,
    target: 'scheduled leads',
  },
  {
    id: 'post-treatment-care',
    name: 'Post-Treatment Care',
    description: 'Aftercare check-ins, review requests, and referral program.',
    steps: 8,
    duration: '90 days',
    channel: 'multi' as const,
    target: 'completed leads',
  },
  {
    id: 'winback',
    name: 'Winback Campaign',
    description: 'Long-term re-engagement for lost leads. Soft touch with new offers.',
    steps: 4,
    duration: '6 months',
    channel: 'email' as const,
    target: 'lost leads (30+ days)',
  },
  {
    id: 'cancellation-recovery',
    name: 'Cancellation Recovery',
    description: 'Immediate response when a lead tries to cancel at any stage.',
    steps: 3,
    duration: '5 days',
    channel: 'multi' as const,
    target: 'leads who request cancellation',
  },
  {
    id: 'unresponsive-reactivation',
    name: 'Unresponsive Reactivation',
    description: 'Multi-channel sequence to re-engage leads who stopped responding.',
    steps: 5,
    duration: '14 days',
    channel: 'multi' as const,
    target: 'leads with no response in 5+ days',
  },
]

// Get rule by transition
export function getTransitionRules(fromSlug: string | null, toSlug: string): StageTransitionRule[] {
  return DEFAULT_TRANSITION_RULES.filter(
    (r) => r.enabled && (r.fromStage === fromSlug || r.fromStage === null) && r.toStage === toSlug
  )
}

// Get all rules for a given stage
export function getStageRules(stageSlug: string): StageTransitionRule[] {
  return DEFAULT_TRANSITION_RULES.filter(
    (r) => r.enabled && (r.toStage === stageSlug || r.fromStage === stageSlug)
  )
}
