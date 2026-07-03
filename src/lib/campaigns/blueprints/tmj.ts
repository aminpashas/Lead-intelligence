/**
 * TMJ blueprint — medical-adjacent nurture for jaw pain / TMD inquiries.
 * Different psychology again: these leads are in PAIN today, so the arc leads
 * with relief and legitimacy (this is a real, treatable condition), stays
 * clinical in tone, and is careful with medical claims and insurance framing.
 */

import { z } from 'zod'
import type { CampaignBlueprint } from './types'
import { CORE_REQUIRED_FIELDS } from './core-pack'

const DAY = 1440 // minutes

export const tmjBlueprint: CampaignBlueprint = {
  slug: 'tmj',
  name: 'TMJ / TMD Treatment',
  description:
    'New-lead nurture for TMJ/jaw-pain inquiries. Leads with symptom relief and clinical legitimacy, explains the diagnostic path, handles insurance questions, and drives an evaluation visit.',
  version: 1,
  targetCriteria: {
    service_line: 'tmj',
    status_in: ['new', 'contacted'],
  },
  addOnQuestions: [
    {
      id: 'tmj-modalities',
      profilePath: 'addon.treatments_text',
      prompt:
        'Which TMJ treatments do you offer — splints/orthotics, Botox, bite adjustment, ortho, referrals for surgery?',
      kind: 'text',
      required: true,
    },
    {
      id: 'tmj-referral',
      profilePath: 'addon.referral_required',
      prompt: 'Do patients need a physician referral, or can they book an evaluation directly?',
      kind: 'boolean',
      required: true,
    },
    {
      id: 'tmj-insurance',
      profilePath: 'addon.insurance_text',
      prompt:
        'How does billing work for TMJ — medical insurance, dental, cash with superbill? What should we tell patients who ask?',
      kind: 'text',
      required: true,
    },
  ],
  addonSchema: z
    .object({
      treatments_text: z.string().max(2000).nullish(),
      referral_required: z.boolean().nullish(),
      insurance_text: z.string().max(2000).nullish(),
    })
    .strict()
    .partial(),
  requiredProfileFields: [
    ...CORE_REQUIRED_FIELDS,
    'addon.treatments_text',
    'addon.referral_required',
    'addon.insurance_text',
  ],
  guardrails: [
    'Never diagnose or promise symptom relief — describe what evaluation and treatment CAN address, invite the visit.',
    'Insurance answers only from [[insurance_text]] — never guess coverage.',
    'Pain language: acknowledge and validate, never dramatize or exploit.',
  ],
  kpis: ['Replies', 'Evaluations booked', 'Show rate', 'Revenue attributed'],
  steps: [
    {
      step_number: 1,
      name: 'Instant welcome + symptom question',
      channel: 'sms',
      delay_minutes: 0,
      ai_personalize: false,
      body_template:
        "Hi {{first_name}}, this is [[practice_name]] — thanks for reaching out about jaw pain/TMJ. Sorry you're dealing with this. Quick question to point you right: is it mostly pain/tension, clicking/locking, headaches, or a mix?",
    },
    {
      step_number: 2,
      name: 'Intro email — this is treatable',
      channel: 'email',
      delay_minutes: 4 * 60,
      ai_personalize: true,
      subject: 'Jaw pain is real — and treatable',
      body_template:
        "Hi {{first_name}},\n\nTMJ problems get dismissed a lot — but they're a real, diagnosable condition, and there are proven ways to treat them. At [[practice_name]] we offer: [[treatments_text]]\n\nThe first step is an evaluation ([[consult_fee_text]]). We're open [[hours_text]]. Reply with any question — including insurance, which I can explain.",
    },
    {
      step_number: 3,
      name: 'Education — why it happens',
      channel: 'sms',
      delay_minutes: 1 * DAY,
      ai_personalize: true,
      body_template:
        "Hi {{first_name}}, one thing worth knowing: TMJ symptoms (jaw pain, headaches, ear pressure, clicking) usually trace back to how the joint and bite work together — which is exactly what we evaluate. How long has this been going on for you?",
    },
    {
      step_number: 4,
      name: 'Trust — the evaluation path',
      channel: 'email',
      delay_minutes: 2 * DAY,
      ai_personalize: true,
      subject: 'What a TMJ evaluation involves',
      body_template:
        "Hi {{first_name}},\n\nHere's what your evaluation looks like: [[consult_flow_text]]\n\nYou leave with an actual explanation of what's going on and a treatment plan — not a shrug. We see evaluations [[consult_days_text]]. Want me to find you a time?",
    },
    {
      step_number: 5,
      name: 'Insurance / cost clarity',
      channel: 'sms',
      delay_minutes: 2 * DAY,
      ai_personalize: true,
      body_template:
        "Hi {{first_name}}, the question everyone asks: does insurance cover TMJ treatment? Short version for our office: [[insurance_text]] Happy to walk through your specific situation — want to talk it over or just book the evaluation?",
    },
    {
      step_number: 6,
      name: 'Cost of waiting (clinical, honest)',
      channel: 'email',
      delay_minutes: 3 * DAY,
      ai_personalize: true,
      subject: 'Why TMJ problems rarely fix themselves',
      body_template:
        "Hi {{first_name}},\n\nUntreated TMJ issues tend to compound — muscles guard, wear patterns worsen, and pain that started occasional becomes constant. That's not a scare tactic; it's the reason early evaluation matters.\n\nIf the pain has been shaping your days, reply here or call [[practice_phone]] and we'll get you looked at.",
    },
    {
      step_number: 7,
      name: 'Soft check-in',
      channel: 'sms',
      delay_minutes: 4 * DAY,
      ai_personalize: true,
      body_template:
        "Hi {{first_name}}, checking in — how's the jaw been this week? If it's still bothering you, don't white-knuckle it; the evaluation is the fastest way to real answers.",
    },
    {
      step_number: 8,
      name: 'Door open (final scheduled touch)',
      channel: 'email',
      delay_minutes: 9 * DAY,
      ai_personalize: true,
      subject: 'Here when you need us, {{first_name}}',
      body_template:
        "Hi {{first_name}},\n\nI'll stop nudging — but TMJ pain has a way of coming back around, and when it does, we're here. Reply to this email anytime and we'll get you evaluated quickly.\n\n— [[practice_name]]",
    },
  ],
}
