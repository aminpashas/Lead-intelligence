/**
 * Core interview pack — the shared practice questions asked ONCE per org,
 * whatever campaign type is being set up. Answers land in practice_profiles.core
 * and are reused by every subsequent service-line launch (which only asks its
 * own add-on delta).
 *
 * These are guidance for the interview agent, not a rigid form: the agent asks
 * conversationally, may get three answers from one reply, and records whatever
 * the practice reveals — but the REQUIRED subset below gates every launch.
 */

import type { InterviewQuestion } from './types'

export const CORE_QUESTIONS: InterviewQuestion[] = [
  {
    id: 'hours-weekly',
    profilePath: 'core.hours.weekly_text',
    prompt: 'What are your office hours through the week?',
    kind: 'hours',
    required: true,
  },
  {
    id: 'hours-consult-days',
    profilePath: 'core.hours.consult_days',
    prompt: 'Which days (and times) do the doctors actually see consults — is it every day, or specific blocks?',
    kind: 'text',
    required: true,
  },
  {
    id: 'ops-phones',
    profilePath: 'core.operations.phone_coverage',
    prompt: 'Who answers the phones, and during which hours? Anything after-hours (answering service, voicemail, AI)?',
    kind: 'text',
    required: false,
  },
  {
    id: 'ops-same-day',
    profilePath: 'core.operations.same_day_policy',
    prompt: 'Can a new patient ever be seen same-day or next-day, or is there a minimum lead time?',
    kind: 'text',
    required: false,
  },
  {
    id: 'appt-duration',
    profilePath: 'core.appointments.consult_duration_minutes',
    prompt: 'How long is a new-patient consult on the schedule?',
    kind: 'text',
    required: true,
  },
  {
    id: 'appt-types',
    profilePath: 'core.appointments.types',
    prompt: 'Do you offer consults in person only, or also virtual/phone consults?',
    kind: 'choice',
    choices: ['in_person', 'virtual', 'phone'],
    required: true,
  },
  {
    id: 'flow-steps',
    profilePath: 'core.consult_flow.steps_text',
    prompt: 'Walk me through what actually happens at a consult, start to finish — imaging, doctor time, treatment plan, financial conversation.',
    kind: 'text',
    required: true,
  },
  {
    id: 'flow-run-by',
    profilePath: 'core.consult_flow.run_by',
    prompt: 'Who runs the consult day-to-day — the doctor start to finish, or a treatment coordinator with the doctor stepping in?',
    kind: 'text',
    required: false,
  },
  {
    id: 'flow-sedation',
    profilePath: 'core.consult_flow.sedation_offered',
    prompt: 'Do you offer sedation options?',
    kind: 'boolean',
    required: false,
  },
  {
    id: 'tech-ehr',
    profilePath: 'core.technology.ehr',
    prompt: 'What practice-management / EHR system do you run, and what imaging (CBCT?) do you have in-house?',
    kind: 'text',
    required: false,
  },
  {
    id: 'tech-financing',
    profilePath: 'core.technology.financing_partners',
    prompt: 'Which financing partners do you work with (Cherry, Proceed, CareCredit, in-house…)?',
    kind: 'text',
    required: true,
  },
  {
    id: 'price-consult-fee',
    profilePath: 'core.pricing.consult_fee_text',
    prompt: 'What does the consult cost the patient — free, a fee, a fee credited toward treatment?',
    kind: 'money',
    required: true,
  },
  {
    id: 'price-posture',
    profilePath: 'core.pricing.financing_posture',
    prompt: 'How do you want money discussed before the consult? (e.g. "never quote numbers by text", "share the starting-at range", "financing-first framing")',
    kind: 'text',
    required: true,
  },
  {
    id: 'price-insurance',
    profilePath: 'core.pricing.insurance_stance',
    prompt: 'Where do you stand on insurance — in-network, out-of-network with courtesy billing, or not applicable for this service?',
    kind: 'text',
    required: false,
  },
  {
    id: 'pref-must-mention',
    profilePath: 'core.preferences.must_mention',
    prompt: 'Anything you always want mentioned to prospective patients (awards, technology, doctor credentials, guarantee)?',
    kind: 'text',
    required: false,
  },
  {
    id: 'pref-never-say',
    profilePath: 'core.preferences.never_say',
    prompt: 'Anything the AI must NEVER say or promise (discount language, specific prices, timeline guarantees)?',
    kind: 'text',
    required: true,
  },
  {
    id: 'pref-tone',
    profilePath: 'core.preferences.tone_notes',
    prompt: 'How should we sound — warm and casual, clinical and premium, somewhere in between?',
    kind: 'text',
    required: false,
  },
]

/** Core answers required before ANY service line can launch. */
export const CORE_REQUIRED_FIELDS: string[] = CORE_QUESTIONS.filter((q) => q.required).map(
  (q) => q.profilePath
)
