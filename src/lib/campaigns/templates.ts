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
]
