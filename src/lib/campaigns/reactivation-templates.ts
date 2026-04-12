/**
 * Pre-built reactivation campaign templates.
 * These are specialized for re-engaging dormant, lost, or unresponsive leads
 * with AI-powered hooks, promos, and incentives.
 */

import type { ReactivationGoal, ReactivationTone, ReactivationHookStrategy } from '@/types/database'

export type ReactivationTemplate = {
  id: string
  name: string
  description: string
  goal: ReactivationGoal
  tone: ReactivationTone
  channel: 'sms' | 'email' | 'multi'
  hooks: ReactivationHookStrategy[]
  engagement_rules: {
    max_attempts: number
    cooldown_days: number
    escalation_strategy: string
    stop_on_reply: boolean
    transition_to_live: boolean
  }
  default_offers: Array<{
    name: string
    description: string
    type: 'percentage_off' | 'dollar_off' | 'free_addon' | 'financing_special' | 'limited_time'
    value: number
  }>
  steps: Array<{
    step_number: number
    name: string
    channel: 'sms' | 'email'
    delay_minutes: number
    subject?: string
    body_template: string
    ai_personalize: boolean
    exit_condition?: Record<string, unknown>
  }>
}

export const REACTIVATION_TEMPLATES: ReactivationTemplate[] = [
  // ─── COLD LEAD REVIVAL (5 steps, 14 days) ───────────
  {
    id: 'cold-lead-revival',
    name: 'Cold Lead Revival',
    description: 'Re-engage leads who went cold 30+ days ago. Uses empathy + new offers to reignite interest.',
    goal: 're_engage',
    tone: 'empathetic',
    channel: 'multi',
    hooks: ['empathy', 'special_pricing', 'new_technology'],
    engagement_rules: {
      max_attempts: 5,
      cooldown_days: 3,
      escalation_strategy: 'vary_channel',
      stop_on_reply: true,
      transition_to_live: true,
    },
    default_offers: [
      {
        name: 'Free 3D CT Scan',
        description: 'Complimentary 3D CT scan ($500+ value) with any consultation booking',
        type: 'free_addon',
        value: 500,
      },
    ],
    steps: [
      {
        step_number: 1,
        name: 'Warm Re-Introduction SMS',
        channel: 'sms',
        delay_minutes: 0,
        body_template: `Hi {{first_name}}, it's been a while since we last connected about your smile. We haven't forgotten about you! A lot has changed at {{practice_name}} — we'd love to share some exciting updates. Are you still thinking about permanent teeth? Just text back YES and I'll fill you in. 😊`,
        ai_personalize: false,
      },
      {
        step_number: 2,
        name: 'Value Re-Statement Email',
        channel: 'email',
        delay_minutes: 2880, // 2 days
        subject: "{{first_name}}, we've been thinking about you",
        body_template: '',
        ai_personalize: true,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 3,
        name: 'Special Offer SMS',
        channel: 'sms',
        delay_minutes: 5760, // 4 days
        body_template: `{{first_name}}, I wanted to share something special — we're offering a complimentary 3D CT Scan ($500+ value) for patients who book a consultation this month. No strings attached. Would you like me to save a spot for you? Just reply YES 🦷`,
        ai_personalize: false,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 4,
        name: 'AI Personalized Hook',
        channel: 'sms',
        delay_minutes: 10080, // 7 days
        body_template: '',
        ai_personalize: true,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 5,
        name: 'Final Gentle Touch',
        channel: 'email',
        delay_minutes: 20160, // 14 days
        subject: "No pressure at all, {{first_name}} — just checking in",
        body_template: `Hi {{first_name}},

I know life gets busy, and there's never a "perfect time" for big decisions. I just wanted you to know that we're still here whenever you're ready.

A few things that might be helpful:

• Your free consultation offer doesn't expire
• We now offer monthly payments as low as $199/mo
• Most patients say their only regret was not doing it sooner

Whenever the time is right, just reply to this email. No pressure, no expiration.

Rooting for you,
{{practice_name}}`,
        ai_personalize: false,
      },
    ],
  },

  // ─── LOST LEAD WIN-BACK (4 steps, 21 days) ──────────
  {
    id: 'lost-lead-winback',
    name: 'Lost Lead Win-Back',
    description: 'Target leads marked as "lost" with fresh offers and new angles. Great for old databases.',
    goal: 'win_back',
    tone: 'professional',
    channel: 'multi',
    hooks: ['special_pricing', 'new_technology', 'social_proof'],
    engagement_rules: {
      max_attempts: 4,
      cooldown_days: 5,
      escalation_strategy: 'increase_value',
      stop_on_reply: true,
      transition_to_live: true,
    },
    default_offers: [
      {
        name: 'Returning Patient Discount',
        description: '15% off treatment for returning patients who book this month',
        type: 'percentage_off',
        value: 15,
      },
      {
        name: '$0 Down Financing',
        description: 'Special $0 down payment financing for returning patients',
        type: 'financing_special',
        value: 0,
      },
    ],
    steps: [
      {
        step_number: 1,
        name: 'Fresh Start SMS',
        channel: 'sms',
        delay_minutes: 0,
        body_template: `Hi {{first_name}}, I know it's been a while! We've made some exciting changes at {{practice_name}} and I thought of you. We're now offering special pricing for returning patients. Would you be interested in hearing more? Just text TELL ME MORE 😊`,
        ai_personalize: false,
      },
      {
        step_number: 2,
        name: 'New Technology Email',
        channel: 'email',
        delay_minutes: 5760, // 4 days
        subject: "Things have changed since we last spoke, {{first_name}}",
        body_template: '',
        ai_personalize: true,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 3,
        name: 'Exclusive Offer SMS',
        channel: 'sms',
        delay_minutes: 10080, // 7 days
        body_template: '',
        ai_personalize: true,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 4,
        name: 'Win-Back Email',
        channel: 'email',
        delay_minutes: 30240, // 21 days
        subject: "One more thing, {{first_name}}...",
        body_template: '',
        ai_personalize: true,
      },
    ],
  },

  // ─── NO-SHOW RECOVERY PLUS (4 steps, 10 days) ───────
  {
    id: 'no-show-recovery-plus',
    name: 'No-Show Recovery Plus',
    description: 'Enhanced no-show recovery with incentives. Addresses anxiety and adds urgency.',
    goal: 're_engage',
    tone: 'empathetic',
    channel: 'multi',
    hooks: ['empathy', 'urgency', 'special_pricing'],
    engagement_rules: {
      max_attempts: 4,
      cooldown_days: 2,
      escalation_strategy: 'vary_channel',
      stop_on_reply: true,
      transition_to_live: true,
    },
    default_offers: [
      {
        name: 'No-Show Forgiveness Package',
        description: 'We understand nerves happen — $200 off your treatment when you reschedule',
        type: 'dollar_off',
        value: 200,
      },
    ],
    steps: [
      {
        step_number: 1,
        name: 'Gentle No-Show SMS',
        channel: 'sms',
        delay_minutes: 120, // 2 hours after no-show
        body_template: `{{first_name}}, we noticed you couldn't make it today. No worries at all — we know dental visits can feel overwhelming. When you're ready, we'd love to reschedule. Plus, we're offering $200 off your treatment as our way of saying we're here for you. 💛`,
        ai_personalize: false,
      },
      {
        step_number: 2,
        name: 'Encouragement Email',
        channel: 'email',
        delay_minutes: 2880, // 2 days
        subject: "{{first_name}}, it's okay — we've all been there",
        body_template: '',
        ai_personalize: true,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 3,
        name: 'Social Proof SMS',
        channel: 'sms',
        delay_minutes: 7200, // 5 days
        body_template: '',
        ai_personalize: true,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 4,
        name: 'Last Reach SMS',
        channel: 'sms',
        delay_minutes: 14400, // 10 days
        body_template: `{{first_name}}, just one more message from me. Your $200 treatment credit is still waiting, and your free consultation spot is reserved. Whenever you're ready — even months from now — just text "READY" and I'll personally help you. No judgment, no pressure. 🙏`,
        ai_personalize: false,
      },
    ],
  },

  // ─── DATABASE REACTIVATION BLITZ (6 steps, 10 days) ──
  {
    id: 'database-reactivation-blitz',
    name: 'Database Reactivation Blitz',
    description: 'Intensive 10-day campaign for bulk uploaded databases. High-touch, multi-channel, AI-driven.',
    goal: 're_engage',
    tone: 'casual',
    channel: 'multi',
    hooks: ['urgency', 'special_pricing', 'social_proof', 'personalized_value'],
    engagement_rules: {
      max_attempts: 6,
      cooldown_days: 1,
      escalation_strategy: 'vary_hook',
      stop_on_reply: true,
      transition_to_live: true,
    },
    default_offers: [
      {
        name: 'Limited Time Special',
        description: 'Book this week and get a free digital smile preview + 10% off treatment',
        type: 'limited_time',
        value: 10,
      },
      {
        name: 'Free Smile Preview',
        description: 'Complimentary digital smile design — see your new teeth before committing',
        type: 'free_addon',
        value: 300,
      },
    ],
    steps: [
      {
        step_number: 1,
        name: 'Intro SMS',
        channel: 'sms',
        delay_minutes: 0,
        body_template: `Hey {{first_name}}! 👋 This is {{practice_name}}. We're reaching out to people who showed interest in dental implants. We have some incredible offers right now — including a FREE digital smile preview. Curious? Just text back YES!`,
        ai_personalize: false,
      },
      {
        step_number: 2,
        name: 'Value Email',
        channel: 'email',
        delay_minutes: 1440, // 1 day
        subject: "{{first_name}}, see your new smile before you commit",
        body_template: '',
        ai_personalize: true,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 3,
        name: 'Hook SMS 1',
        channel: 'sms',
        delay_minutes: 2880, // 2 days
        body_template: '',
        ai_personalize: true,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 4,
        name: 'Social Proof Email',
        channel: 'email',
        delay_minutes: 5760, // 4 days
        subject: "People just like you are getting new smiles, {{first_name}}",
        body_template: '',
        ai_personalize: true,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 5,
        name: 'Urgency SMS',
        channel: 'sms',
        delay_minutes: 10080, // 7 days
        body_template: `{{first_name}}, heads up — our special offer (FREE smile preview + 10% off) expires this week. Only a few consultation spots left. Want me to hold one for you? Reply YES ⏰`,
        ai_personalize: false,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 6,
        name: 'Final Touch Email',
        channel: 'email',
        delay_minutes: 14400, // 10 days
        subject: "Last chance, {{first_name}} — your offer is expiring",
        body_template: '',
        ai_personalize: true,
      },
    ],
  },

  // ─── VIP RE-ENGAGEMENT (5 steps, 30 days) ────────────
  {
    id: 'vip-re-engagement',
    name: 'VIP Re-Engagement',
    description: 'Premium nurture sequence for high-value leads that went dormant. White-glove treatment.',
    goal: 'win_back',
    tone: 'professional',
    channel: 'multi',
    hooks: ['personalized_value', 'new_technology', 'empathy', 'special_pricing'],
    engagement_rules: {
      max_attempts: 5,
      cooldown_days: 5,
      escalation_strategy: 'increase_value',
      stop_on_reply: true,
      transition_to_live: true,
    },
    default_offers: [
      {
        name: 'VIP Consultation Package',
        description: 'Exclusive VIP consultation with the doctor, 3D scan, digital smile design, and a $500 treatment credit',
        type: 'dollar_off',
        value: 500,
      },
      {
        name: 'Priority Financing',
        description: 'Pre-approved financing with 0% interest for the first 12 months',
        type: 'financing_special',
        value: 0,
      },
    ],
    steps: [
      {
        step_number: 1,
        name: 'Personal SMS',
        channel: 'sms',
        delay_minutes: 0,
        body_template: `{{first_name}}, it's been a while and I wanted to personally reach out. At {{practice_name}}, we've been investing in new technology that makes the All-on-4 experience even better. I'd love to give you a VIP consultation — on us. Interested? Just reply.`,
        ai_personalize: false,
      },
      {
        step_number: 2,
        name: 'VIP Invitation Email',
        channel: 'email',
        delay_minutes: 5760, // 4 days
        subject: "A personal invitation for you, {{first_name}}",
        body_template: '',
        ai_personalize: true,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 3,
        name: 'Follow-Up SMS',
        channel: 'sms',
        delay_minutes: 14400, // 10 days
        body_template: '',
        ai_personalize: true,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 4,
        name: 'Exclusive Offer Email',
        channel: 'email',
        delay_minutes: 28800, // 20 days
        subject: "An exclusive offer I wanted to share, {{first_name}}",
        body_template: '',
        ai_personalize: true,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 5,
        name: 'Graceful Close',
        channel: 'sms',
        delay_minutes: 43200, // 30 days
        body_template: `{{first_name}}, I don't want to overstep, but I wanted you to know your VIP consultation credit ($500 value) doesn't expire. Whenever you're ready — even a year from now — it's yours. Just text me. Wishing you the best! 🌟`,
        ai_personalize: false,
      },
    ],
  },
]

export const HOOK_STRATEGY_OPTIONS: Array<{
  id: ReactivationHookStrategy
  label: string
  emoji: string
  description: string
}> = [
  { id: 'urgency', label: 'Urgency / Scarcity', emoji: '🔥', description: 'Create time pressure with limited spots or expiring offers' },
  { id: 'social_proof', label: 'Social Proof', emoji: '👥', description: 'Share success stories and patient testimonials' },
  { id: 'new_technology', label: 'New Technology', emoji: '🆕', description: 'Highlight new procedures, tools, or techniques' },
  { id: 'special_pricing', label: 'Special Pricing', emoji: '💰', description: 'Exclusive discounts, financing options, or free add-ons' },
  { id: 'empathy', label: 'Empathy / Care', emoji: '💛', description: 'Acknowledge hesitation, show understanding and support' },
  { id: 'personalized_value', label: 'Personalized Value', emoji: '🎯', description: 'Custom messaging based on the lead\'s specific situation' },
]

export const GOAL_OPTIONS: Array<{
  id: ReactivationGoal
  label: string
  description: string
}> = [
  { id: 're_engage', label: 'Re-Engage', description: 'Bring dormant leads back into active conversations' },
  { id: 'win_back', label: 'Win Back', description: 'Re-target leads who were previously lost or declined' },
  { id: 'upsell', label: 'Upsell', description: 'Offer additional services to past patients' },
  { id: 'referral_ask', label: 'Referral Ask', description: 'Ask satisfied patients for referrals with incentives' },
]

export const TONE_OPTIONS: Array<{
  id: ReactivationTone
  label: string
  description: string
}> = [
  { id: 'empathetic', label: 'Empathetic', description: 'Warm, understanding, and supportive' },
  { id: 'urgent', label: 'Urgent', description: 'Time-sensitive, action-oriented, energetic' },
  { id: 'casual', label: 'Casual', description: 'Friendly, conversational, approachable' },
  { id: 'professional', label: 'Professional', description: 'Polished, trustworthy, authoritative' },
]
