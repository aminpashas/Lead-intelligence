/**
 * Comprehensive funnel stage definitions with sales strategies.
 * Each stage has engagement rules, timing windows, escalation triggers,
 * and proven dental implant sales tactics.
 */

export type FunnelStageStrategy = {
  slug: string
  name: string
  goal: string
  maxDaysInStage: number | null
  urgency: 'critical' | 'high' | 'medium' | 'low'
  engagementIntensity: 'intensive' | 'moderate' | 'light'

  // What should happen when a lead enters this stage
  entryActions: StageAction[]

  // Ongoing engagement rules while lead is in this stage
  engagementRules: EngagementRule[]

  // When to escalate (lead is stalling)
  escalationTriggers: EscalationTrigger[]

  // Sales strategies and talk tracks
  salesStrategies: SalesStrategy[]

  // KPIs to track
  kpis: StageKPI[]

  // What success looks like (next stage)
  successTransition: string
  // What failure looks like
  failureTransitions: string[]
}

export type StageAction = {
  type: 'sms' | 'email' | 'task' | 'notification' | 'ai_score'
  delay_minutes: number
  description: string
  template?: string
  assignTo?: 'owner' | 'assigned' | 'manager'
}

export type EngagementRule = {
  channel: 'sms' | 'email' | 'call' | 'multi'
  frequency: string
  description: string
  aiPersonalize: boolean
  timing: string
}

export type EscalationTrigger = {
  condition: string
  afterHours: number
  action: string
  priority: 'urgent' | 'high' | 'medium'
}

export type SalesStrategy = {
  name: string
  description: string
  talkTrack: string
  objectionHandlers: { objection: string; response: string }[]
}

export type StageKPI = {
  name: string
  target: string
  description: string
}

// ════════════════════════════════════════════════════════════════
// COMPLETE FUNNEL PLAYBOOK — All-on-4 Dental Implant Practice
// ════════════════════════════════════════════════════════════════

export const FUNNEL_STAGES: FunnelStageStrategy[] = [

  // ── STAGE 1: NEW LEAD ─────────────────────────────────────
  {
    slug: 'new',
    name: 'New Lead',
    goal: 'Make first contact within 5 minutes. Speed to lead is everything.',
    maxDaysInStage: 2,
    urgency: 'critical',
    engagementIntensity: 'intensive',

    entryActions: [
      {
        type: 'ai_score',
        delay_minutes: 0,
        description: 'AI scores and qualifies lead immediately',
      },
      {
        type: 'sms',
        delay_minutes: 2,
        description: 'Instant welcome SMS within 2 minutes',
        template: 'Hi {{first_name}}! Thanks for reaching out to {{practice_name}} about permanent teeth. I\'m here to help answer any questions. What\'s the #1 thing on your mind?',
      },
      {
        type: 'notification',
        delay_minutes: 0,
        description: 'Alert practice team — new lead arrived',
        assignTo: 'owner',
      },
      {
        type: 'task',
        delay_minutes: 15,
        description: 'Call lead within 15 minutes if no response to SMS',
        assignTo: 'assigned',
      },
    ],

    engagementRules: [
      {
        channel: 'sms',
        frequency: 'Every 4-6 hours for first 24 hours',
        description: 'Rapid follow-up — this is the golden window. If they don\'t respond to SMS, try calling.',
        aiPersonalize: false,
        timing: '9 AM - 8 PM local time',
      },
      {
        channel: 'email',
        frequency: 'Within 1 hour of lead creation',
        description: 'Send education email with before/after photos, free consultation offer',
        aiPersonalize: false,
        timing: 'Immediately after welcome SMS',
      },
      {
        channel: 'call',
        frequency: '2-3 attempts in first 24 hours',
        description: 'Phone call is highest conversion. Try different times of day.',
        aiPersonalize: false,
        timing: 'Vary: morning, lunch, evening',
      },
    ],

    escalationTriggers: [
      {
        condition: 'No response to any outreach',
        afterHours: 4,
        action: 'Manager notification: Hot lead going cold. Call personally.',
        priority: 'urgent',
      },
      {
        condition: 'No response after 24 hours',
        afterHours: 24,
        action: 'Enroll in intensive 7-day nurture campaign',
        priority: 'high',
      },
      {
        condition: 'No response after 48 hours',
        afterHours: 48,
        action: 'Move to "Contacted" with unresponsive flag',
        priority: 'medium',
      },
    ],

    salesStrategies: [
      {
        name: 'Speed to Lead',
        description: 'The practice that responds first wins 78% of the time. Every minute counts.',
        talkTrack: 'Hi [name], this is [rep] from [practice]. I saw you were looking into permanent teeth — that\'s exciting! I just wanted to quickly see if you had any questions I could help with right now?',
        objectionHandlers: [
          {
            objection: 'I\'m just looking/researching',
            response: 'That\'s exactly what our free consultation is for! No commitment at all. We do a 3D scan, show you exactly what your new smile would look like, and give you a clear price. Most people say it was the best hour they spent. Would Tuesday or Thursday work better?',
          },
          {
            objection: 'I need to think about it',
            response: 'Absolutely, take your time. What specifically would help you decide? Is it the cost, the procedure, or something else? I want to make sure you have all the info you need.',
          },
          {
            objection: 'How much does it cost?',
            response: 'Great question. All-on-4 typically ranges from $20-30k per arch, but we have patients paying as low as $199/month with financing. The exact price depends on your specific situation — that\'s what the free consultation determines. And the 3D scan alone is worth $500.',
          },
        ],
      },
    ],

    kpis: [
      { name: 'Speed to First Contact', target: '< 5 minutes', description: 'Time from lead creation to first outreach' },
      { name: 'Contact Rate', target: '> 80%', description: 'Percentage of leads contacted within 1 hour' },
      { name: 'Response Rate', target: '> 40%', description: 'Percentage of leads who respond to first outreach' },
      { name: 'Conversion to Contacted', target: '> 90%', description: 'Leads that move to Contacted stage within 48h' },
    ],

    successTransition: 'contacted',
    failureTransitions: ['unresponsive'],
  },

  // ── STAGE 2: CONTACTED ────────────────────────────────────
  {
    slug: 'contacted',
    name: 'Contacted',
    goal: 'Build rapport and qualify. Get them to commit to a consultation.',
    maxDaysInStage: 5,
    urgency: 'high',
    engagementIntensity: 'intensive',

    entryActions: [
      {
        type: 'task',
        delay_minutes: 0,
        description: 'Review lead profile and AI score. Personalize approach.',
        assignTo: 'assigned',
      },
      {
        type: 'email',
        delay_minutes: 30,
        description: 'Send personalized follow-up based on their dental condition',
      },
    ],

    engagementRules: [
      {
        channel: 'multi',
        frequency: 'Daily for first 5 days',
        description: 'Alternate SMS and email. Each touch should provide VALUE — education, social proof, or specific answers to their situation.',
        aiPersonalize: true,
        timing: '9 AM - 7 PM, vary times daily',
      },
      {
        channel: 'call',
        frequency: 'Every other day',
        description: 'Phone calls convert 3x better than text. Always have a reason to call (new info, limited spots, etc.)',
        aiPersonalize: false,
        timing: 'Mid-morning or early evening',
      },
    ],

    escalationTriggers: [
      {
        condition: 'No engagement after 3 touches',
        afterHours: 72,
        action: 'Switch to AI-personalized objection handling',
        priority: 'high',
      },
      {
        condition: 'Negative sentiment detected in messages',
        afterHours: 0,
        action: 'Route to manager for personal outreach',
        priority: 'urgent',
      },
      {
        condition: 'Still in stage after 5 days',
        afterHours: 120,
        action: 'Move to long-term nurture or disqualify',
        priority: 'medium',
      },
    ],

    salesStrategies: [
      {
        name: 'Value-First Education',
        description: 'Don\'t sell — educate. Share specific info relevant to THEIR dental situation.',
        talkTrack: 'Based on what you shared about [their condition], here\'s what I want you to know: [specific benefit]. Many of our patients with similar situations are now [outcome]. Would you like to see some before-and-after photos?',
        objectionHandlers: [
          {
            objection: 'I\'m talking to other offices too',
            response: 'Smart move — you should compare. Here\'s what makes us different: [differentiator]. Either way, our free consultation gives you the most information to make your decision. No strings attached.',
          },
          {
            objection: 'I don\'t have insurance/it\'s too expensive',
            response: 'I hear you. Most of our patients use financing, not insurance. We get people approved in 20 minutes, often for $199-399/month. And here\'s the thing — doing nothing costs more long-term with infections, bone loss, and emergency visits.',
          },
          {
            objection: 'I\'m scared of the procedure',
            response: 'That\'s completely normal. Here\'s what most patients say: "I was terrified... and then I woke up and it was done." We use IV sedation — you literally sleep through it. You wake up with new teeth. Would it help to talk to a patient who\'s been through it?',
          },
        ],
      },
      {
        name: 'Social Proof Drip',
        description: 'Share patient stories that mirror the lead\'s situation',
        talkTrack: 'I was just thinking of you — we had a patient last month with [similar condition]. She was nervous too, but now she can\'t stop smiling. She said the hardest part was making the phone call.',
        objectionHandlers: [],
      },
    ],

    kpis: [
      { name: 'Qualification Rate', target: '> 60%', description: 'Leads that get qualified within 5 days' },
      { name: 'Consultation Booking Rate', target: '> 35%', description: 'Contacted leads who schedule a consultation' },
      { name: 'Average Touches to Book', target: '< 7', description: 'Number of outreach attempts before booking' },
    ],

    successTransition: 'qualified',
    failureTransitions: ['unresponsive', 'disqualified'],
  },

  // ── STAGE 3: QUALIFIED ────────────────────────────────────
  {
    slug: 'qualified',
    name: 'Qualified',
    goal: 'Book the consultation appointment. This is the critical conversion point.',
    maxDaysInStage: 3,
    urgency: 'critical',
    engagementIntensity: 'intensive',

    entryActions: [
      {
        type: 'notification',
        delay_minutes: 0,
        description: 'Alert: Qualified lead ready to book! Call within 30 minutes.',
        assignTo: 'assigned',
      },
      {
        type: 'sms',
        delay_minutes: 5,
        description: 'Congratulations message + direct booking link/CTA',
        template: '{{first_name}}, great news — based on what you\'ve shared, you\'re a perfect candidate for All-on-4 implants! Let\'s get you scheduled for your FREE consultation + 3D scan. What day works best this week?',
      },
      {
        type: 'task',
        delay_minutes: 30,
        description: 'Call lead to book consultation while they\'re warm',
        assignTo: 'assigned',
      },
    ],

    engagementRules: [
      {
        channel: 'call',
        frequency: 'Immediately and then daily until booked',
        description: 'Phone call is the #1 way to convert qualified leads to consultations. Be assumptive — "I have openings Tuesday and Thursday, which works better?"',
        aiPersonalize: false,
        timing: 'Call within 30 minutes of qualification',
      },
      {
        channel: 'sms',
        frequency: 'Daily with increasing urgency',
        description: 'Use scarcity and urgency — limited spots, special pricing, etc.',
        aiPersonalize: true,
        timing: 'Morning or early afternoon',
      },
    ],

    escalationTriggers: [
      {
        condition: 'Not booked within 24 hours',
        afterHours: 24,
        action: 'Manager call — offer VIP scheduling or incentive',
        priority: 'urgent',
      },
      {
        condition: 'Not booked within 3 days',
        afterHours: 72,
        action: 'Send limited-time offer or bonus (e.g., free whitening with consult)',
        priority: 'high',
      },
    ],

    salesStrategies: [
      {
        name: 'Assumptive Close',
        description: 'Don\'t ask IF they want to schedule — ask WHEN.',
        talkTrack: 'I have your file right here and you\'re an excellent candidate. Dr. [name] has openings this Tuesday at 10 AM or Thursday at 2 PM — which one should I put you down for?',
        objectionHandlers: [
          {
            objection: 'I need to check my schedule',
            response: 'Of course! I\'ll text you our available times right now so you can pick one when you check. These spots go fast since we only do a few consultations per day. Sound good?',
          },
          {
            objection: 'I need to talk to my spouse first',
            response: 'Absolutely — bring them along! Having support is huge. We encourage spouses to attend the consultation so everyone is on the same page. What day works for both of you?',
          },
          {
            objection: 'Can I do a virtual consultation?',
            response: 'We do offer virtual first visits! But honestly, the in-person consultation is much more valuable because of the 3D CT scan — it lets us see your bone structure and plan exactly. Plus it\'s completely free. Would you want to try the in-person version?',
          },
        ],
      },
    ],

    kpis: [
      { name: 'Booking Rate', target: '> 70%', description: 'Qualified leads who book a consultation' },
      { name: 'Time to Book', target: '< 48 hours', description: 'Average time from qualification to booking' },
      { name: 'Drop-off Rate', target: '< 20%', description: 'Qualified leads lost before booking' },
    ],

    successTransition: 'consultation-scheduled',
    failureTransitions: ['unresponsive', 'lost'],
  },

  // ── STAGE 4: CONSULTATION SCHEDULED ───────────────────────
  {
    slug: 'consultation-scheduled',
    name: 'Consultation Scheduled',
    goal: 'Ensure they SHOW UP. No-shows kill revenue. Pre-frame the value.',
    maxDaysInStage: 14,
    urgency: 'high',
    engagementIntensity: 'moderate',

    entryActions: [
      {
        type: 'email',
        delay_minutes: 5,
        description: 'Confirmation email with date/time, office address, what to expect, what to bring',
      },
      {
        type: 'sms',
        delay_minutes: 10,
        description: 'Quick confirmation SMS with appointment details',
        template: 'Awesome, {{first_name}}! You\'re confirmed for {{consultation_date}}. Here\'s what happens: 3D CT scan → Digital smile design → Custom treatment plan → Financing options. All FREE. See you there! 😊',
      },
      {
        type: 'task',
        delay_minutes: 0,
        description: 'Add to appointment schedule, prepare patient file',
        assignTo: 'assigned',
      },
    ],

    engagementRules: [
      {
        channel: 'email',
        frequency: '3 days before appointment',
        description: 'Pre-consultation education email — what to expect, patient testimonials, parking info',
        aiPersonalize: false,
        timing: '3 days before scheduled date',
      },
      {
        channel: 'sms',
        frequency: '24 hours before + 1 hour before',
        description: 'Automated appointment reminders. 24h: SMS + email. 1h: SMS only.',
        aiPersonalize: false,
        timing: '24h and 1h before appointment',
      },
      {
        channel: 'sms',
        frequency: 'Day before appointment',
        description: 'Excitement builder — "Tomorrow is going to be amazing" message with social proof',
        aiPersonalize: true,
        timing: 'Evening before appointment',
      },
    ],

    escalationTriggers: [
      {
        condition: 'No confirmation response to reminder',
        afterHours: 0,
        action: 'Call to verbally confirm appointment',
        priority: 'urgent',
      },
      {
        condition: 'Mentions rescheduling or canceling',
        afterHours: 0,
        action: 'Immediate call to save the appointment. Offer alternative times.',
        priority: 'urgent',
      },
      {
        condition: 'Appointment is > 7 days out',
        afterHours: 0,
        action: 'Extra nurture touches to keep engagement high. Share video testimonials.',
        priority: 'medium',
      },
    ],

    salesStrategies: [
      {
        name: 'Pre-Frame the Experience',
        description: 'Build anticipation. Make them excited about the consultation, not nervous.',
        talkTrack: 'I just wanted to let you know — patients tell us the consultation is actually fun. You get to see a 3D model of your mouth and a preview of your new smile on screen. It\'s like a makeover preview. And Dr. [name] will answer every single question.',
        objectionHandlers: [
          {
            objection: 'I need to reschedule',
            response: 'No problem at all! Let me find another time that works. We only have a few consultation slots each week though — when would be better? [Offer 2 specific times]',
          },
          {
            objection: 'I\'m thinking of canceling',
            response: 'I understand it\'s a big step. Can I ask what changed? [Listen, then address]. Remember, there\'s zero obligation — you\'re just getting information. And the 3D scan alone is worth $500. Would it help if I had Dr. [name] call you first?',
          },
        ],
      },
      {
        name: 'No-Show Prevention',
        description: 'Multi-touch confirmation sequence to maximize show rates',
        talkTrack: 'Just a friendly reminder about your appointment tomorrow at [time]. We have your 3D scan machine reserved and Dr. [name] is looking forward to meeting you. See you at [address]!',
        objectionHandlers: [],
      },
    ],

    kpis: [
      { name: 'Show Rate', target: '> 80%', description: 'Percentage of scheduled consultations that show up' },
      { name: 'Confirmation Rate', target: '> 95%', description: 'Leads who confirm before appointment' },
      { name: 'Cancellation Rate', target: '< 10%', description: 'Scheduled consultations that cancel' },
    ],

    successTransition: 'consultation-completed',
    failureTransitions: ['no_show', 'lost'],
  },

  // ── STAGE 5: CONSULTATION COMPLETED ───────────────────────
  {
    slug: 'consultation-completed',
    name: 'Consultation Completed',
    goal: 'Present treatment plan. Close same-day if possible. If not, follow up aggressively.',
    maxDaysInStage: 7,
    urgency: 'critical',
    engagementIntensity: 'intensive',

    entryActions: [
      {
        type: 'email',
        delay_minutes: 60,
        description: 'Send personalized treatment summary with plan details, photos, and next steps',
      },
      {
        type: 'sms',
        delay_minutes: 120,
        description: 'Thank you + "we\'re excited about your treatment plan" message',
        template: '{{first_name}}, it was great meeting you today! Your treatment plan is incredible — you\'re going to love your new smile. I\'m sending over all the details now. Any questions, just text me!',
      },
      {
        type: 'task',
        delay_minutes: 0,
        description: 'Log consultation notes, treatment plan details, and objections raised',
        assignTo: 'assigned',
      },
    ],

    engagementRules: [
      {
        channel: 'call',
        frequency: 'Next business day, then every other day',
        description: 'Follow-up call is critical. "Just checking in — did you have any questions after sleeping on it?"',
        aiPersonalize: false,
        timing: 'Morning after consultation',
      },
      {
        channel: 'sms',
        frequency: 'Daily for first 3 days',
        description: 'Value-add messages: financing info, patient stories, answers to common post-consult questions',
        aiPersonalize: true,
        timing: 'Afternoon/evening',
      },
      {
        channel: 'email',
        frequency: 'Day 2 and Day 5',
        description: 'Detailed follow-ups: financing calculator, before/after gallery, FAQ doc',
        aiPersonalize: true,
        timing: 'Morning',
      },
    ],

    escalationTriggers: [
      {
        condition: 'No response within 48 hours',
        afterHours: 48,
        action: 'Manager/doctor personal follow-up call',
        priority: 'urgent',
      },
      {
        condition: 'Mentions cost concerns',
        afterHours: 0,
        action: 'Immediately route to financing specialist',
        priority: 'urgent',
      },
      {
        condition: 'Still in stage after 7 days',
        afterHours: 168,
        action: 'Offer second opinion consult or limited-time incentive',
        priority: 'high',
      },
    ],

    salesStrategies: [
      {
        name: 'Same-Day Close',
        description: 'The best time to close is during the consultation. Have financing ready.',
        talkTrack: 'Based on your 3D scan, you\'re a great candidate. Dr. [name] recommends [treatment]. The total investment is $[amount], but with financing you\'d be looking at just $[monthly] per month. Should we get you approved right now? It takes about 10 minutes.',
        objectionHandlers: [
          {
            objection: 'I need to think about it',
            response: 'Absolutely. What specifically would you like to think through? If it\'s the cost, I can run a few different financing scenarios for you right now. If it\'s the procedure, Dr. [name] can address any concerns.',
          },
          {
            objection: 'I want to get a second opinion',
            response: 'Smart approach. We actually encourage it — confidence is important for a decision this big. Just know that we price very competitively and include things many offices charge extra for, like the temporary teeth and 3D planning.',
          },
          {
            objection: 'It costs more than I expected',
            response: 'I understand. Let me show you something — when you factor in the cost of ongoing dental work, denture replacements, and emergency visits over the next 10-20 years, implants actually save money. Plus, our financing starts at $199/month. Want to see the comparison?',
          },
        ],
      },
      {
        name: 'Follow-Up Close',
        description: 'For leads who didn\'t close same-day, the 24-48 hour window is critical',
        talkTrack: 'Hi [name], I was just reviewing your treatment plan with Dr. [name] and we both agreed — you\'re going to have an amazing result. I wanted to check if any questions came up overnight that I can help with?',
        objectionHandlers: [
          {
            objection: 'My spouse isn\'t sure',
            response: 'Would it help if Dr. [name] called your spouse directly? Or we could set up a brief video call together. It\'s a big decision and having everyone informed makes a huge difference.',
          },
        ],
      },
    ],

    kpis: [
      { name: 'Same-Day Close Rate', target: '> 30%', description: 'Patients who commit during consultation' },
      { name: 'Treatment Acceptance Rate', target: '> 60%', description: 'Consultations that accept treatment within 7 days' },
      { name: 'Average Time to Accept', target: '< 3 days', description: 'Days from consultation to treatment acceptance' },
    ],

    successTransition: 'treatment-presented',
    failureTransitions: ['lost', 'unresponsive'],
  },

  // ── STAGE 6: TREATMENT PRESENTED ──────────────────────────
  {
    slug: 'treatment-presented',
    name: 'Treatment Presented',
    goal: 'Overcome objections. Get commitment. Move to financing or contract.',
    maxDaysInStage: 14,
    urgency: 'high',
    engagementIntensity: 'moderate',

    entryActions: [
      {
        type: 'task',
        delay_minutes: 0,
        description: 'Prepare personalized treatment summary document with financing options',
        assignTo: 'assigned',
      },
      {
        type: 'email',
        delay_minutes: 30,
        description: 'Send formal treatment plan document with itemized costs and financing scenarios',
      },
    ],

    engagementRules: [
      {
        channel: 'call',
        frequency: 'Day 1, 3, 5, 7, 10',
        description: 'Structured follow-up calls. Each call has a specific purpose (financing, concerns, timeline, commitment)',
        aiPersonalize: false,
        timing: 'Afternoon preferred',
      },
      {
        channel: 'sms',
        frequency: 'Between calls',
        description: 'Low-pressure value messages: testimonials from patients with same condition, before/after photos',
        aiPersonalize: true,
        timing: 'Varies',
      },
      {
        channel: 'email',
        frequency: 'Day 3 and Day 7',
        description: 'Detailed content: financing guide, insurance info, recovery timeline, FAQ',
        aiPersonalize: true,
        timing: 'Morning',
      },
    ],

    escalationTriggers: [
      {
        condition: 'Mentions competitor or shopping around',
        afterHours: 0,
        action: 'Doctor personal call + competitive comparison sheet',
        priority: 'urgent',
      },
      {
        condition: 'No engagement after 7 days',
        afterHours: 168,
        action: 'Offer limited-time incentive or complimentary additional service',
        priority: 'high',
      },
      {
        condition: 'Stuck after 14 days',
        afterHours: 336,
        action: 'Move to long-term nurture. Monthly check-ins.',
        priority: 'medium',
      },
    ],

    salesStrategies: [
      {
        name: 'Financing First',
        description: '80% of objections are about money. Lead with financing options.',
        talkTrack: 'I ran the numbers three different ways for you. Option A: $199/month for 60 months. Option B: $299/month for 36 months. Option C: 10% discount if you pay within 30 days. Which would work best for your budget?',
        objectionHandlers: [
          {
            objection: 'I can\'t afford it right now',
            response: 'I completely understand. That\'s exactly why we offer $0 down financing. You could start your new smile journey with zero out of pocket and payments under $250/month. Plus, we have multiple lenders — if one doesn\'t approve, another often does.',
          },
          {
            objection: 'ClearChoice quoted me less',
            response: 'Let me make sure we\'re comparing apples to apples. Our price includes [list inclusions]. ClearChoice often has add-on costs for [common add-ons]. Also, our lab is in-house which means faster turnaround and better quality control. Want me to do a side-by-side comparison?',
          },
        ],
      },
      {
        name: 'Emotional Close',
        description: 'Connect the procedure to their life goals and pain points',
        talkTrack: 'You told me during your consultation that [their pain point — can\'t eat, embarrassed to smile, etc.]. Imagine [positive future]. That\'s what we\'re really talking about here — not just teeth, but your quality of life.',
        objectionHandlers: [],
      },
    ],

    kpis: [
      { name: 'Acceptance Rate', target: '> 50%', description: 'Leads who accept treatment within 14 days' },
      { name: 'Financing Application Rate', target: '> 70%', description: 'Leads who apply for financing' },
      { name: 'Average Deal Size', target: '> $25,000', description: 'Average treatment value at this stage' },
    ],

    successTransition: 'financing',
    failureTransitions: ['lost', 'unresponsive'],
  },

  // ── STAGE 7: FINANCING ────────────────────────────────────
  {
    slug: 'financing',
    name: 'Financing',
    goal: 'Get financing approved. Handle denials with alternative lenders.',
    maxDaysInStage: 7,
    urgency: 'high',
    engagementIntensity: 'moderate',

    entryActions: [
      {
        type: 'sms',
        delay_minutes: 5,
        description: 'Guide them through financing application process',
        template: '{{first_name}}, let\'s get your financing sorted! It takes about 5 minutes and won\'t affect your credit score (soft pull). I\'ll text you the link right now. Questions? Just ask!',
      },
      {
        type: 'task',
        delay_minutes: 0,
        description: 'Send financing application link and track completion',
        assignTo: 'assigned',
      },
    ],

    engagementRules: [
      {
        channel: 'call',
        frequency: 'Same day as application, then daily until resolved',
        description: 'Walk them through the application on the phone if needed. Check status daily.',
        aiPersonalize: false,
        timing: 'Business hours',
      },
      {
        channel: 'sms',
        frequency: 'Daily updates on financing status',
        description: 'Keep them informed. "Application submitted" → "Under review" → "Approved!"',
        aiPersonalize: false,
        timing: 'Afternoon',
      },
    ],

    escalationTriggers: [
      {
        condition: 'Financing denied',
        afterHours: 0,
        action: 'Immediately try alternative lender. Don\'t let denial kill the deal.',
        priority: 'urgent',
      },
      {
        condition: 'Application not started after 48 hours',
        afterHours: 48,
        action: 'Call to assist with application. Offer to do it together on the phone.',
        priority: 'high',
      },
      {
        condition: 'Approved but not proceeding',
        afterHours: 72,
        action: 'Call to celebrate approval and move to contract signing',
        priority: 'urgent',
      },
    ],

    salesStrategies: [
      {
        name: 'Remove Financing Friction',
        description: 'Make the financing process as easy as possible. Offer to do it together.',
        talkTrack: 'I know financing paperwork isn\'t anyone\'s favorite thing. Want me to stay on the phone while you fill it out? Takes about 5 minutes and I can answer any questions as they come up.',
        objectionHandlers: [
          {
            objection: 'I was denied',
            response: 'Don\'t worry — that lender is just one option. We work with 5 different financing companies, and each has different criteria. Let me submit to [alternative] right now. We get most people approved.',
          },
          {
            objection: 'The monthly payment is too high',
            response: 'Let me see what we can do. We might be able to extend the term to bring it down, or I can check if a small down payment would reduce it significantly. What monthly amount would be comfortable?',
          },
        ],
      },
    ],

    kpis: [
      { name: 'Approval Rate', target: '> 85%', description: 'Financing applications approved (including alternative lenders)' },
      { name: 'Time to Approval', target: '< 48 hours', description: 'Average time from application to approval' },
      { name: 'Proceeding Rate', target: '> 80%', description: 'Approved patients who move to contract' },
    ],

    successTransition: 'contract-signed',
    failureTransitions: ['lost'],
  },

  // ── STAGE 8: CONTRACT SIGNED ──────────────────────────────
  {
    slug: 'contract-signed',
    name: 'Contract Signed',
    goal: 'Schedule treatment date. Handle pre-procedure anxiety. Prevent cancellations.',
    maxDaysInStage: 30,
    urgency: 'medium',
    engagementIntensity: 'moderate',

    entryActions: [
      {
        type: 'sms',
        delay_minutes: 5,
        description: 'Celebration message! Build excitement.',
        template: '🎉 {{first_name}}, it\'s OFFICIAL! Your new smile journey starts now. We\'re going to take amazing care of you. Next step: scheduling your procedure date. I\'ll call you shortly to find the perfect day!',
      },
      {
        type: 'email',
        delay_minutes: 30,
        description: 'Welcome packet: pre-op instructions, what to expect day-of, aftercare guide',
      },
      {
        type: 'task',
        delay_minutes: 60,
        description: 'Schedule treatment date, order materials, prep lab work',
        assignTo: 'assigned',
      },
    ],

    engagementRules: [
      {
        channel: 'email',
        frequency: 'Weekly until treatment date',
        description: 'Countdown emails: pre-op instructions, diet changes, medication adjustments, "1 week away!" etc.',
        aiPersonalize: false,
        timing: 'Monday mornings',
      },
      {
        channel: 'sms',
        frequency: '1 week before, 3 days before, 1 day before',
        description: 'Excitement and preparation reminders. Address any last-minute anxiety.',
        aiPersonalize: true,
        timing: 'Morning',
      },
    ],

    escalationTriggers: [
      {
        condition: 'Mentions wanting to cancel or having doubts',
        afterHours: 0,
        action: 'Doctor personal call immediately. Address specific concerns.',
        priority: 'urgent',
      },
      {
        condition: 'Treatment date not scheduled after 7 days',
        afterHours: 168,
        action: 'Call to schedule. Offer multiple options.',
        priority: 'high',
      },
    ],

    salesStrategies: [
      {
        name: 'Pre-Procedure Confidence Building',
        description: 'Between contract and treatment, buyer\'s remorse is the #1 risk. Counter with excitement.',
        talkTrack: 'I know you might feel some butterflies — that\'s totally normal! Every one of our patients felt the same way. But they all say the same thing afterward: "Why didn\'t I do this sooner?" You\'re going to do great.',
        objectionHandlers: [
          {
            objection: 'I\'m having second thoughts',
            response: 'Let\'s talk about what\'s on your mind. Is it the procedure itself, the cost, or something else? [Listen]. That\'s completely valid. Would it help to talk to Dr. [name] directly? Or I can connect you with a patient who had the same concerns.',
          },
          {
            objection: 'I want to cancel',
            response: 'I understand this is a big decision. Before you decide, would you be open to a quick call with Dr. [name]? Sometimes talking through the specific concerns makes all the difference. No pressure at all.',
          },
        ],
      },
    ],

    kpis: [
      { name: 'Cancellation Rate', target: '< 5%', description: 'Signed contracts that cancel before treatment' },
      { name: 'Time to Treatment', target: '< 21 days', description: 'Average days from contract to treatment date' },
      { name: 'Pre-op Compliance', target: '> 95%', description: 'Patients who complete pre-op requirements' },
    ],

    successTransition: 'scheduled',
    failureTransitions: ['lost'],
  },

  // ── STAGE 9: SCHEDULED FOR TREATMENT ──────────────────────
  {
    slug: 'scheduled',
    name: 'Scheduled for Treatment',
    goal: 'Ensure show-up. Final pre-op prep. Smooth handoff to clinical team.',
    maxDaysInStage: 30,
    urgency: 'medium',
    engagementIntensity: 'light',

    entryActions: [
      {
        type: 'email',
        delay_minutes: 0,
        description: 'Detailed pre-op checklist email: medications to stop, food restrictions, ride home arrangements',
      },
      {
        type: 'task',
        delay_minutes: 0,
        description: 'Verify lab work ordered, materials received, clinical team briefed',
        assignTo: 'assigned',
      },
    ],

    engagementRules: [
      {
        channel: 'sms',
        frequency: '1 week, 3 days, 1 day before',
        description: 'Pre-op reminders with checklist items. Excitement messages.',
        aiPersonalize: false,
        timing: 'Morning',
      },
      {
        channel: 'email',
        frequency: '1 week before treatment',
        description: 'Final pre-op email with day-of instructions, what to wear, what to bring',
        aiPersonalize: false,
        timing: 'Morning',
      },
    ],

    escalationTriggers: [
      {
        condition: 'Requests cancellation or reschedule',
        afterHours: 0,
        action: 'Doctor call immediately. Explore options to reschedule rather than cancel.',
        priority: 'urgent',
      },
    ],

    salesStrategies: [
      {
        name: 'Day-Before Confidence Call',
        description: 'Personal call the evening before to calm nerves and confirm logistics',
        talkTrack: 'Hi [name], just calling to say we\'re all set for tomorrow! The team is excited for you. Quick reminders: nothing to eat after midnight, wear comfortable clothes, and have someone drive you. Any questions? You\'re going to do amazing.',
        objectionHandlers: [],
      },
    ],

    kpis: [
      { name: 'Show Rate', target: '> 98%', description: 'Scheduled treatments that proceed' },
      { name: 'Same-Day Cancellation', target: '< 2%', description: 'Last-minute cancellations' },
    ],

    successTransition: 'completed',
    failureTransitions: ['lost'],
  },

  // ── STAGE 10: COMPLETED ───────────────────────────────────
  {
    slug: 'completed',
    name: 'Completed',
    goal: 'Maximize lifetime value. Get reviews, referrals, and follow-up care revenue.',
    maxDaysInStage: null,
    urgency: 'low',
    engagementIntensity: 'light',

    entryActions: [
      {
        type: 'sms',
        delay_minutes: 1440, // 1 day post-procedure
        description: 'Check-in: "How are you feeling? Any questions about aftercare?"',
        template: 'Hi {{first_name}}! How are you feeling today? Remember: soft foods for the first week, take your meds as prescribed. Any questions or concerns, text me anytime. We\'re here for you! 😊',
      },
      {
        type: 'email',
        delay_minutes: 4320, // 3 days
        description: 'Aftercare instructions email with recovery timeline and emergency contact',
      },
      {
        type: 'task',
        delay_minutes: 10080, // 7 days
        description: 'Schedule follow-up appointment and check on recovery',
        assignTo: 'assigned',
      },
    ],

    engagementRules: [
      {
        channel: 'sms',
        frequency: 'Day 1, 3, 7, 14, 30 post-procedure',
        description: 'Recovery check-ins. Then transition to long-term care reminders.',
        aiPersonalize: true,
        timing: 'Morning',
      },
      {
        channel: 'email',
        frequency: 'Month 1, 3, 6, 12 post-procedure',
        description: 'Long-term: review requests, referral program, annual checkup reminders',
        aiPersonalize: false,
        timing: 'Morning',
      },
    ],

    escalationTriggers: [
      {
        condition: 'Reports pain or complications',
        afterHours: 0,
        action: 'Immediate clinical team notification',
        priority: 'urgent',
      },
    ],

    salesStrategies: [
      {
        name: 'Review & Referral Engine',
        description: 'Happy patients are your best marketing. Systematize the ask.',
        talkTrack: '[Name], we love seeing your new smile! Would you be willing to share your experience? A Google review helps other people like you find us. And if you know anyone who might benefit, we have a referral bonus of $[amount].',
        objectionHandlers: [],
      },
      {
        name: 'Second Arch Upsell',
        description: 'If they only did one arch, follow up about the second at 3-6 months',
        talkTrack: 'Now that you\'ve seen the amazing results on your [upper/lower] teeth, many patients decide to complete the set. Would you like to discuss your [other arch] options?',
        objectionHandlers: [],
      },
    ],

    kpis: [
      { name: 'Review Rate', target: '> 60%', description: 'Completed patients who leave a Google review' },
      { name: 'Referral Rate', target: '> 25%', description: 'Patients who refer at least one person' },
      { name: 'Second Arch Rate', target: '> 20%', description: 'Single-arch patients who do the second arch' },
      { name: 'Follow-up Compliance', target: '> 90%', description: 'Patients who attend follow-up appointments' },
    ],

    successTransition: 'completed', // Terminal
    failureTransitions: [],
  },

  // ── STAGE 11: LOST ────────────────────────────────────────
  {
    slug: 'lost',
    name: 'Lost',
    goal: 'Log the reason. Re-engage quarterly. Some lost leads come back months later.',
    maxDaysInStage: null,
    urgency: 'low',
    engagementIntensity: 'light',

    entryActions: [
      {
        type: 'task',
        delay_minutes: 0,
        description: 'Document lost reason in detail. Log for analytics.',
        assignTo: 'assigned',
      },
      {
        type: 'email',
        delay_minutes: 1440,
        description: 'Graceful exit email: "Door is always open. No expiration on your consultation."',
      },
    ],

    engagementRules: [
      {
        channel: 'email',
        frequency: 'Monthly for 3 months, then quarterly',
        description: 'Soft nurture: practice news, new technology, patient stories. No hard sell.',
        aiPersonalize: false,
        timing: 'Monthly',
      },
    ],

    escalationTriggers: [
      {
        condition: 'Lead re-engages (opens email, visits website, responds to message)',
        afterHours: 0,
        action: 'Immediately re-activate and assign to team member. Call within 1 hour.',
        priority: 'urgent',
      },
    ],

    salesStrategies: [
      {
        name: 'Winback Campaign',
        description: 'After 30-90 days, reach out with something new: special pricing, new technology, limited-time offer',
        talkTrack: 'Hi [name], I hope you\'re doing well! I wanted to reach out because we recently [new technology/offer]. I remembered you were considering implants and thought of you. No pressure at all — just wanted you to know the option is still there.',
        objectionHandlers: [],
      },
    ],

    kpis: [
      { name: 'Winback Rate', target: '> 10%', description: 'Lost leads who re-engage within 6 months' },
      { name: 'Lost Reason Logging', target: '100%', description: 'Every lost lead has a documented reason' },
    ],

    successTransition: 'new', // Re-enter funnel
    failureTransitions: [],
  },
]

// ════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ════════════════════════════════════════════════════════════════

export function getStageStrategy(slug: string): FunnelStageStrategy | undefined {
  return FUNNEL_STAGES.find((s) => s.slug === slug)
}

export function getStageByIndex(index: number): FunnelStageStrategy | undefined {
  return FUNNEL_STAGES[index]
}

export function getNextStage(currentSlug: string): string | null {
  const stage = FUNNEL_STAGES.find((s) => s.slug === currentSlug)
  return stage?.successTransition ?? null
}

export function getStageUrgencyColor(urgency: FunnelStageStrategy['urgency']): string {
  switch (urgency) {
    case 'critical': return 'text-red-600 bg-red-50'
    case 'high': return 'text-orange-600 bg-orange-50'
    case 'medium': return 'text-blue-600 bg-blue-50'
    case 'low': return 'text-gray-600 bg-gray-50'
  }
}

export function getIntensityBadge(intensity: FunnelStageStrategy['engagementIntensity']): { label: string; color: string } {
  switch (intensity) {
    case 'intensive': return { label: 'Intensive', color: 'bg-red-100 text-red-700' }
    case 'moderate': return { label: 'Moderate', color: 'bg-yellow-100 text-yellow-700' }
    case 'light': return { label: 'Light', color: 'bg-green-100 text-green-700' }
  }
}
