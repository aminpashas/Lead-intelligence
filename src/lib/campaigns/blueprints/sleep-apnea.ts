/**
 * Sleep apnea blueprint — the most operationally distinct line: diagnosis
 * usually requires a sleep study, billing is medical-insurance-heavy, and the
 * lead is often a CPAP-intolerant patient (or their fed-up bed partner). The
 * arc leads with health stakes + the CPAP-alternative angle and drives a
 * consultation / home-sleep-test pathway.
 */

import { z } from 'zod'
import type { CampaignBlueprint } from './types'
import { CORE_REQUIRED_FIELDS } from './core-pack'

const DAY = 1440 // minutes

export const sleepApneaBlueprint: CampaignBlueprint = {
  slug: 'sleep_apnea',
  name: 'Sleep Apnea / Oral Appliance',
  description:
    'New-lead nurture for snoring and sleep-apnea inquiries. Explains the diagnosis pathway (sleep study → oral appliance), positions the CPAP alternative, handles medical-insurance framing, and drives a consultation.',
  version: 1,
  targetCriteria: {
    service_line: 'sleep_apnea',
    status_in: ['new', 'contacted'],
  },
  addOnQuestions: [
    {
      id: 'sleep-hst',
      profilePath: 'addon.home_sleep_test',
      prompt:
        'Can you arrange home sleep tests (directly or via a physician partner), or do patients need an existing diagnosis to start?',
      kind: 'boolean',
      required: true,
    },
    {
      id: 'sleep-pathway',
      profilePath: 'addon.pathway_text',
      prompt:
        'Walk me through your sleep pathway — from "I snore" to wearing an appliance: testing, diagnosis sign-off, appliance selection, titration, follow-up.',
      kind: 'text',
      required: true,
    },
    {
      id: 'sleep-insurance',
      profilePath: 'addon.insurance_text',
      prompt:
        'How does billing work — medical insurance for the appliance, Medicare, cash? What should we tell patients who ask about coverage?',
      kind: 'text',
      required: true,
    },
  ],
  addonSchema: z
    .object({
      home_sleep_test: z.boolean().nullish(),
      pathway_text: z.string().max(2000).nullish(),
      insurance_text: z.string().max(2000).nullish(),
    })
    .strict()
    .partial(),
  requiredProfileFields: [
    ...CORE_REQUIRED_FIELDS,
    'addon.home_sleep_test',
    'addon.pathway_text',
    'addon.insurance_text',
  ],
  guardrails: [
    'Sleep apnea is a medical condition — never diagnose, never tell a patient to stop using their CPAP, and position oral appliances as a physician-coordinated alternative.',
    'Insurance answers only from [[insurance_text]] — never guess medical coverage.',
    'Health stakes (blood pressure, heart, daytime fatigue) may be stated factually and calmly, never as fear-mongering.',
  ],
  kpis: ['Replies', 'Consults booked', 'Sleep tests started', 'Revenue attributed'],
  computeVars: ({ addon }) => ({
    home_sleep_test_hint:
      addon.home_sleep_test === true ? ' — we can even arrange a home sleep test' : '',
  }),
  steps: [
    {
      step_number: 1,
      name: 'Instant welcome + situation question',
      channel: 'sms',
      delay_minutes: 0,
      ai_personalize: false,
      body_template:
        "Hi {{first_name}}, this is [[practice_name]] — thanks for reaching out about snoring/sleep apnea. Quick question so I can point you right: have you already had a sleep study, or is the snoring (yours or a partner's) the starting point?",
    },
    {
      step_number: 2,
      name: 'Intro email — the pathway',
      channel: 'email',
      delay_minutes: 4 * 60,
      ai_personalize: true,
      subject: 'From snoring to sleeping — how it works',
      body_template:
        "Hi {{first_name}},\n\nHere's the path most patients take with us: [[pathway_text]]\n\nIf you've tried (or dreaded) CPAP: a custom oral appliance is a proven, physician-coordinated alternative for many patients — small, silent, no hose.\n\nFirst step is a consultation ([[consult_fee_text]]). We're open [[hours_text]]. Reply with any question, including insurance.",
    },
    {
      step_number: 3,
      name: 'Education — why it matters',
      channel: 'sms',
      delay_minutes: 1 * DAY,
      ai_personalize: true,
      body_template:
        "Hi {{first_name}}, worth knowing: snoring plus daytime tiredness is often untreated sleep apnea, and it quietly wears on blood pressure, heart health, and energy. The good news — it's very treatable. How's your sleep been lately?",
    },
    {
      step_number: 4,
      name: 'Trust — what the consult involves',
      channel: 'email',
      delay_minutes: 2 * DAY,
      ai_personalize: true,
      subject: 'What your sleep consultation looks like',
      body_template:
        "Hi {{first_name}},\n\nAt your consultation: [[consult_flow_text]]\n\nYou'll leave knowing whether an oral appliance fits your situation and exactly what the next step is. We see consults [[consult_days_text]] — want me to find you a time?",
    },
    {
      step_number: 5,
      name: 'Insurance / cost clarity',
      channel: 'sms',
      delay_minutes: 2 * DAY,
      ai_personalize: true,
      body_template:
        "Hi {{first_name}}, the big question — coverage. For our office: [[insurance_text]] We also work with [[financing_partners]] if there's a gap. Want me to check what your path would look like?",
    },
    {
      step_number: 6,
      name: 'The bed-partner angle + stakes',
      channel: 'email',
      delay_minutes: 3 * DAY,
      ai_personalize: true,
      subject: 'Your sleep affects two people',
      body_template:
        "Hi {{first_name}},\n\nHalf our sleep patients come in because a partner finally insisted. Whether that's you or them: treating apnea usually means quieter nights, real energy in the morning, and taking pressure off your heart.\n\nWhen you're ready, reply here or call [[practice_phone]].",
    },
    {
      step_number: 7,
      name: 'Soft check-in',
      channel: 'sms',
      delay_minutes: 4 * DAY,
      ai_personalize: true,
      body_template:
        "Hi {{first_name}}, checking in — still sleeping rough? Getting evaluated is easier than most people expect[[home_sleep_test_hint]]. Happy to walk you through it.",
    },
    {
      step_number: 8,
      name: 'Door open (final scheduled touch)',
      channel: 'email',
      delay_minutes: 9 * DAY,
      ai_personalize: true,
      subject: 'Sleep like this is optional, {{first_name}}',
      body_template:
        "Hi {{first_name}},\n\nLast note from me — poor sleep has a way of feeling normal until it's treated. Whenever you're ready to fix it, reply to this email and we'll take it from there.\n\n— [[practice_name]]",
    },
  ],
}
