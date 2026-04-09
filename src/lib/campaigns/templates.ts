/**
 * Pre-built campaign templates for dental implant practices.
 * These can be one-click deployed from the campaigns page.
 */

export type CampaignTemplate = {
  id: string
  name: string
  description: string
  type: 'drip' | 'broadcast' | 'trigger'
  channel: 'sms' | 'email' | 'multi'
  target_criteria: Record<string, unknown>
  send_window: Record<string, unknown>
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

export const CAMPAIGN_TEMPLATES: CampaignTemplate[] = [
  // ─── NEW LEAD NURTURE (7 steps, 14 days) ───────────
  {
    id: 'new-lead-nurture',
    name: 'New Lead Nurture',
    description: '7-step SMS + email sequence over 14 days. Educates, builds trust, and drives to consultation.',
    type: 'drip',
    channel: 'multi',
    target_criteria: {
      status: ['new', 'contacted'],
      has_phone: true,
    },
    send_window: { start_hour: 9, end_hour: 20, timezone: 'America/New_York', days: [1, 2, 3, 4, 5, 6] },
    steps: [
      {
        step_number: 1,
        name: 'Welcome SMS',
        channel: 'sms',
        delay_minutes: 5, // 5 min after enrollment
        body_template: `Hi {{first_name}}! Thanks for your interest in permanent teeth at {{practice_name}}. You took the first step — that's huge. We're here to answer ANY questions. What's the #1 thing you want to know? Just text back.`,
        ai_personalize: false,
      },
      {
        step_number: 2,
        name: 'Education Email',
        channel: 'email',
        delay_minutes: 1440, // 1 day
        subject: '{{first_name}}, here\'s what permanent teeth actually look like',
        body_template: `Hi {{first_name}},

I wanted to share something that might help you picture what's possible.

All-on-4 dental implants aren't like dentures — they're thin, beautiful, permanent teeth that look completely natural. You can eat steak, apples, corn on the cob — anything you want.

Here's what most people don't know:
- You get new teeth the SAME DAY as your procedure
- You sleep through the whole thing (IV sedation)
- They last 20+ years
- Over 98% success rate

The best part? Your consultation is 100% FREE — including a 3D CT scan worth $500+.

Ready to see what your new smile could look like? Just reply to this email or call us.

Warm regards,
{{practice_name}}

P.S. We have limited consultation spots this month. Don't wait too long!`,
        ai_personalize: false,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 3,
        name: 'Check-in SMS',
        channel: 'sms',
        delay_minutes: 2880, // 2 days
        body_template: `Hey {{first_name}} — just checking in. Did you get a chance to look at our email? Lots of people have questions about cost. Good news: most patients get approved for monthly payments as low as $199/mo. Want to learn more?`,
        ai_personalize: false,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 4,
        name: 'Social Proof Email',
        channel: 'email',
        delay_minutes: 4320, // 3 days
        subject: 'How {{first_name}}\'s neighbor got a new smile (true story)',
        body_template: `Hi {{first_name}},

I wanted to share a quick story.

One of our patients — let's call her Patricia — wore dentures for 12 years. She couldn't eat at restaurants. She covered her mouth when she laughed. She'd been to ClearChoice and two other places but couldn't afford it.

Then she found us. We got her approved for financing at $250/month. She got her new permanent teeth in ONE day. That was 2 years ago.

Last week she told me: "I eat ribs every Sunday now. My grandkids love my smile. I wish I'd done this 10 years ago."

Your story could be next, {{first_name}}.

Your FREE consultation includes:
✅ 3D CT Scan (worth $500+)
✅ Digital smile design — see your new teeth on screen
✅ Custom treatment plan with exact pricing
✅ Financing pre-approval — know your monthly payment

No pressure. No obligation. Just answers.

Reply "READY" and we'll call you to schedule.

{{practice_name}}`,
        ai_personalize: false,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 5,
        name: 'Urgency SMS',
        channel: 'sms',
        delay_minutes: 7200, // 5 days
        body_template: `{{first_name}}, I wanted to give you a heads up — we only have a few consultation spots left this month. These include a FREE 3D CT scan ($500+ value). Want me to save one for you? Just text YES`,
        ai_personalize: false,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 6,
        name: 'Objection Handler',
        channel: 'sms',
        delay_minutes: 10080, // 7 days
        body_template: '',
        ai_personalize: true, // AI generates personalized objection handling
        exit_condition: { if_replied: true, if_status_in: ['qualified', 'consultation_scheduled'] },
      },
      {
        step_number: 7,
        name: 'Final Follow-up',
        channel: 'email',
        delay_minutes: 20160, // 14 days
        subject: '{{first_name}}, we haven\'t forgotten about you',
        body_template: `Hi {{first_name}},

We reached out a couple weeks ago about permanent dental implants, and I wanted to check in one last time.

I know life gets busy, and big decisions take time. That's totally okay.

But if you're still thinking about it — even a little — I want you to know:

• Your consultation is still FREE (including the 3D CT scan)
• We can usually get you approved for payments in 20 minutes
• Most patients say they wish they'd done it years sooner

Whenever you're ready, we're here. No pressure, no expiration date on this offer.

Just reply to this email or call us anytime.

Rooting for you,
{{practice_name}}`,
        ai_personalize: false,
      },
    ],
  },

  // ─── NO-SHOW RE-ENGAGEMENT (4 steps, 7 days) ──────
  {
    id: 'no-show-reengagement',
    name: 'No-Show Re-engagement',
    description: '4-step sequence to bring back leads who missed their consultation appointment.',
    type: 'drip',
    channel: 'multi',
    target_criteria: {
      status: ['no_show'],
    },
    send_window: { start_hour: 10, end_hour: 19, timezone: 'America/New_York', days: [1, 2, 3, 4, 5] },
    steps: [
      {
        step_number: 1,
        name: 'Missed You SMS',
        channel: 'sms',
        delay_minutes: 60,
        body_template: `Hi {{first_name}}, we missed you at your appointment today! No worries — life happens. Want to reschedule? We still have your FREE consultation reserved. Just text back a day that works.`,
        ai_personalize: false,
      },
      {
        step_number: 2,
        name: 'Follow-up Email',
        channel: 'email',
        delay_minutes: 1440,
        subject: 'We saved your spot, {{first_name}}',
        body_template: `Hi {{first_name}},

We noticed you weren't able to make your consultation yesterday. No judgment at all — we know schedules get hectic.

The good news? Your FREE consultation (including the $500+ 3D CT scan) is still available. We'd love to reschedule when it's convenient for you.

Just reply with a few times that work, and we'll get you booked.

Looking forward to meeting you!
{{practice_name}}`,
        ai_personalize: false,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 3,
        name: 'Encouragement SMS',
        channel: 'sms',
        delay_minutes: 4320,
        body_template: `{{first_name}}, I get it — this is a big step and it's normal to feel nervous. But I promise, the hardest part is just walking through the door. Everything after that is easy. Can we try again? 😊`,
        ai_personalize: false,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 4,
        name: 'Last Chance',
        channel: 'sms',
        delay_minutes: 10080,
        body_template: `Hey {{first_name}}, just wanted to reach out one more time. Your free consultation spot won't be available forever. When you're ready, we're here. No pressure — just text us anytime. We believe in you! 💪`,
        ai_personalize: false,
      },
    ],
  },

  // ─── EDUCATION DRIP (5 steps, 21 days) ─────────────
  {
    id: 'education-drip',
    name: 'Education Drip',
    description: '5-step email series that educates cold leads about All-on-4 implants over 3 weeks.',
    type: 'drip',
    channel: 'email',
    target_criteria: {
      ai_qualification: ['cold', 'warm'],
      has_email: true,
    },
    send_window: { start_hour: 8, end_hour: 18, timezone: 'America/New_York', days: [1, 2, 3, 4, 5] },
    steps: [
      {
        step_number: 1,
        name: 'What Are All-on-4 Implants?',
        channel: 'email',
        delay_minutes: 0,
        subject: 'What are All-on-4 implants? (And why people are ditching dentures)',
        body_template: '',
        ai_personalize: true,
        exit_condition: { if_status_in: ['qualified', 'consultation_scheduled'] },
      },
      {
        step_number: 2,
        name: 'Cost & Financing Guide',
        channel: 'email',
        delay_minutes: 4320,
        subject: 'How much do dental implants REALLY cost? (The honest answer)',
        body_template: '',
        ai_personalize: true,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 3,
        name: 'Pain & Recovery',
        channel: 'email',
        delay_minutes: 8640,
        subject: 'Does getting dental implants hurt? Here\'s the truth.',
        body_template: '',
        ai_personalize: true,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 4,
        name: 'Success Stories',
        channel: 'email',
        delay_minutes: 14400,
        subject: 'Real patients, real results (photos inside)',
        body_template: '',
        ai_personalize: true,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 5,
        name: 'Consultation Invite',
        channel: 'email',
        delay_minutes: 20160,
        subject: '{{first_name}}, your free consultation is waiting',
        body_template: '',
        ai_personalize: true,
      },
    ],
  },

  // ─── PRE-CONSULTATION WARM-UP (4 steps, until consult) ────
  {
    id: 'pre-consultation-warmup',
    name: 'Pre-Consultation Warm-Up',
    description: 'Builds excitement and reduces no-shows between booking and consultation date.',
    type: 'drip',
    channel: 'multi',
    target_criteria: {
      status: ['consultation_scheduled'],
    },
    send_window: { start_hour: 9, end_hour: 19, timezone: 'America/New_York', days: [1, 2, 3, 4, 5, 6] },
    steps: [
      {
        step_number: 1,
        name: 'What to Expect Email',
        channel: 'email',
        delay_minutes: 1440, // 1 day after booking
        subject: 'Your consultation is coming up! Here\'s what to expect',
        body_template: `Hi {{first_name}},

We're so excited for your upcoming consultation! Here's exactly what will happen:

1️⃣ **3D CT Scan** (5 minutes) — A quick, painless scan that creates a detailed 3D model of your jaw
2️⃣ **Digital Smile Design** (10 minutes) — You'll actually see what your new teeth will look like ON SCREEN
3️⃣ **Doctor Consultation** (20 minutes) — Dr. {{doctor_name}} will review your scan, discuss options, and answer every question
4️⃣ **Custom Treatment Plan** (10 minutes) — Exact pricing, timeline, and financing options

**Total time:** About 45-60 minutes
**Cost:** Completely FREE (including the $500+ 3D scan)
**What to bring:** Just yourself! (And any dental records if you have them)

See you soon!
{{practice_name}}`,
        ai_personalize: false,
      },
      {
        step_number: 2,
        name: 'Social Proof SMS',
        channel: 'sms',
        delay_minutes: 4320, // 3 days after booking
        body_template: `{{first_name}}, I was just looking at a patient's before-and-after photos and thought of you. She had a similar situation and now she can't stop smiling! Can't wait for you to see what's possible at your consultation. 😊`,
        ai_personalize: false,
      },
      {
        step_number: 3,
        name: '24-Hour Reminder',
        channel: 'sms',
        delay_minutes: 0, // Triggered by appointment reminder system
        body_template: `Reminder: Your consultation is TOMORROW at {{appointment_time}}! 📍 {{practice_address}}. You'll be meeting with Dr. {{doctor_name}}. If you need to reschedule, just text us back. See you tomorrow!`,
        ai_personalize: false,
      },
      {
        step_number: 4,
        name: 'Day-Of Excitement',
        channel: 'sms',
        delay_minutes: 0,
        body_template: `Today's the day, {{first_name}}! 🎉 We're ready for you at {{appointment_time}}. Quick tip: write down any questions you want to ask — we'll make sure every one gets answered. See you soon!`,
        ai_personalize: false,
      },
    ],
  },

  // ─── POST-CONSULTATION CLOSE (6 steps, 7 days) ───────────
  {
    id: 'post-consultation-close',
    name: 'Post-Consultation Close',
    description: 'Intensive follow-up sequence to convert consultations into treatment acceptance.',
    type: 'drip',
    channel: 'multi',
    target_criteria: {
      status: ['consultation_completed', 'treatment_presented'],
    },
    send_window: { start_hour: 9, end_hour: 20, timezone: 'America/New_York', days: [1, 2, 3, 4, 5, 6] },
    steps: [
      {
        step_number: 1,
        name: 'Same-Day Thank You',
        channel: 'sms',
        delay_minutes: 120, // 2 hours after consultation
        body_template: `{{first_name}}, it was wonderful meeting you today! I'm really excited about your treatment plan. Your new smile is going to be incredible. If any questions come to mind, just text me — I'm here for you!`,
        ai_personalize: false,
      },
      {
        step_number: 2,
        name: 'Treatment Summary Email',
        channel: 'email',
        delay_minutes: 240, // 4 hours after consultation
        subject: '{{first_name}}, your treatment plan summary',
        body_template: '',
        ai_personalize: true, // AI generates personalized treatment summary
        exit_condition: { if_status_in: ['financing', 'contract_signed'] },
      },
      {
        step_number: 3,
        name: 'Next-Day Follow-Up',
        channel: 'sms',
        delay_minutes: 1440, // 1 day
        body_template: `Good morning {{first_name}}! I was just reviewing your file with Dr. {{doctor_name}} — your scan results are really promising. Did you have a chance to think about any questions? I'd love to help you take the next step.`,
        ai_personalize: false,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 4,
        name: 'Financing Options',
        channel: 'email',
        delay_minutes: 2880, // 2 days
        subject: 'Good news about financing, {{first_name}}',
        body_template: '',
        ai_personalize: true, // AI generates personalized financing scenarios
        exit_condition: { if_status_in: ['financing', 'contract_signed'] },
      },
      {
        step_number: 5,
        name: 'Urgency + Social Proof',
        channel: 'sms',
        delay_minutes: 5760, // 4 days
        body_template: '',
        ai_personalize: true, // AI-personalized objection handling based on consultation notes
        exit_condition: { if_replied: true, if_status_in: ['financing', 'contract_signed'] },
      },
      {
        step_number: 6,
        name: 'Final Push',
        channel: 'sms',
        delay_minutes: 10080, // 7 days
        body_template: '',
        ai_personalize: true,
        exit_condition: { if_replied: true, if_status_in: ['financing', 'contract_signed'] },
      },
    ],
  },

  // ─── CANCELLATION RECOVERY (3 steps, 5 days) ─────────────
  {
    id: 'cancellation-recovery',
    name: 'Cancellation Recovery',
    description: 'Immediate recovery sequence when a lead tries to cancel at any stage.',
    type: 'trigger',
    channel: 'multi',
    target_criteria: {},
    send_window: { start_hour: 9, end_hour: 20, timezone: 'America/New_York', days: [1, 2, 3, 4, 5, 6, 0] },
    steps: [
      {
        step_number: 1,
        name: 'Empathetic Outreach',
        channel: 'sms',
        delay_minutes: 30,
        body_template: `{{first_name}}, I understand things change and that's okay. Before we cancel, could I ask what's holding you back? Sometimes we can help with concerns you might not realize we have solutions for. No pressure at all.`,
        ai_personalize: false,
      },
      {
        step_number: 2,
        name: 'Doctor Outreach',
        channel: 'sms',
        delay_minutes: 1440,
        body_template: '',
        ai_personalize: true,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 3,
        name: 'Door Open Email',
        channel: 'email',
        delay_minutes: 7200, // 5 days
        subject: 'The door is always open, {{first_name}}',
        body_template: `Hi {{first_name}},

I wanted to reach out one more time to let you know — there's no expiration date on your consultation or treatment plan. If your situation changes, we're here.

Some things to keep in mind:
• Your free consultation offer doesn't expire
• Financing pre-approvals can be refreshed anytime
• The longer dental issues go untreated, the more complex (and costly) they become

We genuinely want the best for you, whether that's with us or not. If you ever want to revisit this, just call or text.

Wishing you the best,
{{practice_name}}`,
        ai_personalize: false,
      },
    ],
  },

  // ─── UNRESPONSIVE REACTIVATION (5 steps, 14 days) ────────
  {
    id: 'unresponsive-reactivation',
    name: 'Unresponsive Reactivation',
    description: 'Multi-channel sequence to re-engage leads who stopped responding.',
    type: 'drip',
    channel: 'multi',
    target_criteria: {
      status: ['contacted', 'qualified', 'consultation_completed'],
    },
    send_window: { start_hour: 9, end_hour: 20, timezone: 'America/New_York', days: [1, 2, 3, 4, 5, 6] },
    steps: [
      {
        step_number: 1,
        name: 'Different Channel Attempt',
        channel: 'email',
        delay_minutes: 0,
        subject: '{{first_name}}, I may have the wrong number?',
        body_template: `Hi {{first_name}},

I've been trying to reach you but haven't heard back. Totally understand if the timing isn't right — but I wanted to make sure my messages are getting through!

If email is better for you, just reply here. Or if you prefer a phone call, let me know the best time.

Your free consultation (including the $500+ 3D scan) is still available whenever you're ready.

Best,
{{practice_name}}`,
        ai_personalize: false,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 2,
        name: 'Value Reminder SMS',
        channel: 'sms',
        delay_minutes: 2880, // 2 days
        body_template: `{{first_name}}, just a quick note — your FREE consultation offer is still good. It includes a 3D CT scan worth $500+. No commitment, no pressure. Whenever you're ready, just text YES. 🦷`,
        ai_personalize: false,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 3,
        name: 'AI Personalized Reach',
        channel: 'sms',
        delay_minutes: 5760, // 4 days
        body_template: '',
        ai_personalize: true,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 4,
        name: 'New Angle Email',
        channel: 'email',
        delay_minutes: 10080, // 7 days
        subject: 'Something new I wanted to share with you, {{first_name}}',
        body_template: '',
        ai_personalize: true,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 5,
        name: 'Last Attempt',
        channel: 'sms',
        delay_minutes: 20160, // 14 days
        body_template: `Hey {{first_name}}, this will be my last message for now. I don't want to be a bother! But if you ever want to explore permanent teeth, we're here. Just text "READY" anytime — even months from now. Wishing you the best! 🙏`,
        ai_personalize: false,
      },
    ],
  },

  // ─── POST-TREATMENT CARE (8 steps, 90 days) ──────────────
  {
    id: 'post-treatment-care',
    name: 'Post-Treatment Care & Referral',
    description: 'Aftercare check-ins, review generation, and referral program activation.',
    type: 'drip',
    channel: 'multi',
    target_criteria: {
      status: ['completed'],
    },
    send_window: { start_hour: 9, end_hour: 18, timezone: 'America/New_York', days: [1, 2, 3, 4, 5] },
    steps: [
      {
        step_number: 1,
        name: 'Day 1 Check-In',
        channel: 'sms',
        delay_minutes: 1440,
        body_template: `Hi {{first_name}}! How are you feeling today? Remember: soft foods, take your meds as prescribed, and ice the area if needed. Any concerns at all, text me or call the office. We're here for you! 😊`,
        ai_personalize: false,
      },
      {
        step_number: 2,
        name: 'Day 3 Follow-Up',
        channel: 'sms',
        delay_minutes: 4320,
        body_template: `{{first_name}}, checking in — how's day 3 going? Any swelling should be going down by now. Each day gets better! Don't forget your follow-up appointment. Questions? Just text.`,
        ai_personalize: false,
      },
      {
        step_number: 3,
        name: 'Week 1 Email',
        channel: 'email',
        delay_minutes: 10080,
        subject: 'One week with your new smile, {{first_name}}! 🎉',
        body_template: '',
        ai_personalize: true,
      },
      {
        step_number: 4,
        name: 'Week 2 Review Request',
        channel: 'sms',
        delay_minutes: 20160,
        body_template: `{{first_name}}, we hope you're loving your new smile! 😊 Would you be willing to share your experience? A quick Google review helps other people like you find us. Here's the link: {{review_link}} Thank you so much!`,
        ai_personalize: false,
      },
      {
        step_number: 5,
        name: 'Month 1 Check-In',
        channel: 'email',
        delay_minutes: 43200,
        subject: 'How\'s your new smile treating you, {{first_name}}?',
        body_template: '',
        ai_personalize: true,
      },
      {
        step_number: 6,
        name: 'Month 1 Referral Program',
        channel: 'sms',
        delay_minutes: 44640,
        body_template: '{{first_name}}, we love seeing you smile! Quick question — do you know anyone else who might benefit from permanent teeth? We have a referral program: you get ${{referral_bonus}} for every friend who comes in for a consultation. Just share our number!',
        ai_personalize: false,
      },
      {
        step_number: 7,
        name: 'Month 3 Check-In',
        channel: 'email',
        delay_minutes: 129600,
        subject: '3-month smile check! How\'s everything going, {{first_name}}?',
        body_template: '',
        ai_personalize: true,
      },
      {
        step_number: 8,
        name: 'Month 3 Second Arch',
        channel: 'sms',
        delay_minutes: 131040,
        body_template: '',
        ai_personalize: true, // AI determines if single-arch patient, offers second arch
      },
    ],
  },

  // ─── WINBACK (4 steps, 6 months) ─────────────────────────
  {
    id: 'winback',
    name: 'Winback Campaign',
    description: 'Long-term re-engagement for lost leads. Quarterly soft touch with new offers.',
    type: 'drip',
    channel: 'email',
    target_criteria: {
      status: ['lost'],
      has_email: true,
    },
    send_window: { start_hour: 9, end_hour: 17, timezone: 'America/New_York', days: [2, 3, 4] },
    steps: [
      {
        step_number: 1,
        name: 'Month 1 Re-Introduction',
        channel: 'email',
        delay_minutes: 43200,
        subject: 'Thinking of you, {{first_name}}',
        body_template: '',
        ai_personalize: true,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 2,
        name: 'Month 2 New Technology',
        channel: 'email',
        delay_minutes: 86400,
        subject: 'Something new at {{practice_name}} you should know about',
        body_template: '',
        ai_personalize: true,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 3,
        name: 'Month 4 Special Offer',
        channel: 'email',
        delay_minutes: 172800,
        subject: 'A special invitation for you, {{first_name}}',
        body_template: '',
        ai_personalize: true,
        exit_condition: { if_replied: true },
      },
      {
        step_number: 4,
        name: 'Month 6 Final Touch',
        channel: 'email',
        delay_minutes: 259200,
        subject: 'It\'s been a while, {{first_name}} — we\'re still here',
        body_template: '',
        ai_personalize: true,
      },
    ],
  },
]
