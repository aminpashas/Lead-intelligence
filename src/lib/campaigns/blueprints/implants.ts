/**
 * Implants blueprint — the foundational core for dental-implant campaigns
 * (single tooth through full-arch / All-on-X). New-lead nurture arc over
 * ~21 days: qualify → educate → de-risk money → invite.
 */

import { z } from 'zod'
import type { CampaignBlueprint } from './types'
import { CORE_REQUIRED_FIELDS } from './core-pack'

const DAY = 1440 // minutes

export const implantsBlueprint: CampaignBlueprint = {
  slug: 'implants',
  name: 'Dental Implants',
  description:
    'New-lead nurture for implant inquiries — single tooth to full-arch. Qualifies condition and timeline, builds trust in the practice, de-risks the money conversation, and drives a booked consult.',
  version: 1,
  targetCriteria: {
    service_line: 'implants',
    status_in: ['new', 'contacted'],
  },
  addOnQuestions: [
    {
      id: 'implants-scope',
      profilePath: 'addon.case_scope',
      prompt:
        'What implant cases do you take — single tooth, multiple, full-arch/All-on-X? Anything you refer out (grafting, sinus lifts)?',
      kind: 'text',
      required: true,
    },
    {
      id: 'implants-same-day',
      profilePath: 'addon.same_day_teeth',
      prompt: 'Do you offer same-day teeth / immediate load?',
      kind: 'boolean',
      required: true,
    },
    {
      id: 'implants-price-band',
      profilePath: 'addon.price_band_text',
      prompt:
        'How should we frame implant pricing when a lead pushes — a "starting at" range for full-arch, per-implant range, or no numbers at all before consult?',
      kind: 'money',
      required: true,
    },
  ],
  addonSchema: z
    .object({
      case_scope: z.string().max(2000).nullish(),
      same_day_teeth: z.boolean().nullish(),
      price_band_text: z.string().max(400).nullish(),
    })
    .strict()
    .partial(),
  requiredProfileFields: [
    ...CORE_REQUIRED_FIELDS,
    'addon.case_scope',
    'addon.same_day_teeth',
    'addon.price_band_text',
  ],
  guardrails: [
    'Never invent dollar figures. Pricing may only be framed using the practice\'s own words: [[price_band_text]] and the consult-fee framing [[consult_fee_text]].',
    'Never diagnose. Bone loss, extraction needs, and candidacy are consult topics — invite, don\'t assess.',
    'Financing is discussed as options ([[financing_partners]]), never as approval promises.',
  ],
  kpis: ['Replies', 'Consults booked', 'Show rate', 'Revenue attributed'],
  steps: [
    {
      step_number: 1,
      name: 'Instant welcome + one qualifier',
      channel: 'sms',
      delay_minutes: 0,
      ai_personalize: false,
      body_template:
        "Hi {{first_name}}, this is [[practice_name]] — thanks for reaching out about dental implants! So I can point you the right way: are you looking to replace one tooth, a few, or considering a full new smile?",
    },
    {
      step_number: 2,
      name: 'Intro email — why us',
      channel: 'email',
      delay_minutes: 4 * 60,
      ai_personalize: true,
      subject: 'Your implant questions, answered — [[practice_name]]',
      body_template:
        "Hi {{first_name}},\n\nThanks for your interest in dental implants at [[practice_name]]. Our doctors handle [[case_scope]], and your consultation walks through exactly what your options look like — imaging, a plan, and honest numbers.\n\nConsult details: [[consult_fee_text]]. We're open [[hours_text]].\n\nReply with any question — a real person (with AI help) reads every message.",
    },
    {
      step_number: 3,
      name: 'Education — what implants change',
      channel: 'sms',
      delay_minutes: 1 * DAY,
      ai_personalize: true,
      body_template:
        "Hi {{first_name}}, quick thought — most patients tell us they waited years longer than they needed to. Implants stop the bone loss that missing teeth cause, and treatment is usually easier than people expect. What's the biggest question on your mind?",
    },
    {
      step_number: 4,
      name: 'Trust — technology + credentials',
      channel: 'email',
      delay_minutes: 2 * DAY,
      ai_personalize: true,
      subject: 'What actually happens at an implant consult',
      body_template:
        "Hi {{first_name}},\n\nHere's what a consult with us looks like: [[consult_flow_text]]\n\nYou leave knowing your options and real numbers — no pressure, no surprises. Want me to find you a time? We see consults [[consult_days_text]].",
    },
    {
      step_number: 5,
      name: 'Money — de-risk the cost question',
      channel: 'sms',
      delay_minutes: 2 * DAY,
      ai_personalize: true,
      body_template:
        "Hi {{first_name}}, the #1 question we get is cost — totally fair. [[price_band_text]] The consult is where you get YOUR number, and we work with [[financing_partners]] to make the monthly work. Want to grab a time?",
    },
    {
      step_number: 6,
      name: 'Social proof',
      channel: 'email',
      delay_minutes: 3 * DAY,
      ai_personalize: true,
      subject: 'People in your exact spot',
      body_template:
        "Hi {{first_name}},\n\nWe've guided a lot of people through this exact decision — from one missing tooth to a full new smile. The pattern is always the same: relief that they finally came in.\n\nIf it helps to talk it through first, reply here or call us at [[practice_phone]].",
    },
    {
      step_number: 7,
      name: 'Soft check-in',
      channel: 'sms',
      delay_minutes: 4 * DAY,
      ai_personalize: true,
      body_template:
        "Hi {{first_name}}, no pressure at all — just keeping your spot warm. If timing's the issue, that's normal; if it's questions or cost, I can usually help with both. What would make this easier for you?",
    },
    {
      step_number: 8,
      name: 'Door open (final scheduled touch)',
      channel: 'email',
      delay_minutes: 9 * DAY,
      ai_personalize: true,
      subject: "Whenever you're ready, {{first_name}}",
      body_template:
        "Hi {{first_name}},\n\nI'll stop filling your inbox — just know your inquiry doesn't expire. Whenever you're ready to look at implants seriously, reply to this email and we'll pick right up where we left off.\n\n— [[practice_name]]",
    },
  ],
}
