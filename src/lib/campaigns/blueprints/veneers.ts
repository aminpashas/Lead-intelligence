/**
 * Veneers blueprint — cosmetic smile-design nurture. Different psychology from
 * implants: aspiration over pain relief, so the arc leads with the outcome
 * (the smile), anchors on process/artistry, and handles per-unit price anxiety.
 */

import { z } from 'zod'
import type { CampaignBlueprint } from './types'
import { CORE_REQUIRED_FIELDS } from './core-pack'

const DAY = 1440 // minutes

export const veneersBlueprint: CampaignBlueprint = {
  slug: 'veneers',
  name: 'Porcelain Veneers',
  description:
    'New-lead nurture for cosmetic veneer inquiries. Leads with the smile outcome, explains the smile-design process, frames per-unit pricing the practice\'s way, and drives a cosmetic consult.',
  version: 1,
  targetCriteria: {
    service_line: 'veneers',
    status_in: ['new', 'contacted'],
  },
  addOnQuestions: [
    {
      id: 'veneers-min-units',
      profilePath: 'addon.min_units_text',
      prompt:
        'Do you have a minimum number of veneer units per case (e.g. 6–10 uppers), or do you take single-unit cosmetic cases?',
      kind: 'text',
      required: true,
    },
    {
      id: 'veneers-workflow',
      profilePath: 'addon.smile_design_text',
      prompt:
        'Describe your smile-design workflow — digital preview/mockup, trial smile, lab you use, visits from consult to final seat.',
      kind: 'text',
      required: true,
    },
    {
      id: 'veneers-price-band',
      profilePath: 'addon.price_band_text',
      prompt:
        'How should veneer pricing be framed — per-unit range, full-case range, or no numbers before the consult?',
      kind: 'money',
      required: true,
    },
  ],
  addonSchema: z
    .object({
      min_units_text: z.string().max(400).nullish(),
      smile_design_text: z.string().max(2000).nullish(),
      price_band_text: z.string().max(400).nullish(),
    })
    .strict()
    .partial(),
  requiredProfileFields: [
    ...CORE_REQUIRED_FIELDS,
    'addon.min_units_text',
    'addon.smile_design_text',
    'addon.price_band_text',
  ],
  guardrails: [
    'Never invent dollar figures — pricing only via [[price_band_text]] and [[consult_fee_text]].',
    'Never promise a specific aesthetic result or timeline; the smile design process determines both.',
    'This is an elective, aspirational purchase — sell the outcome and the artistry, never shame the current smile.',
  ],
  kpis: ['Replies', 'Consults booked', 'Show rate', 'Revenue attributed'],
  steps: [
    {
      step_number: 1,
      name: 'Instant welcome + vision question',
      channel: 'sms',
      delay_minutes: 0,
      ai_personalize: false,
      body_template:
        "Hi {{first_name}}, this is [[practice_name]] — love that you're looking into veneers! Quick question so we can help best: is there a smile you have in mind (a look, a photo, a celebrity), or are you exploring what's possible?",
    },
    {
      step_number: 2,
      name: 'Intro email — the process',
      channel: 'email',
      delay_minutes: 4 * 60,
      ai_personalize: true,
      subject: 'How we design a smile at [[practice_name]]',
      body_template:
        "Hi {{first_name}},\n\nGreat smiles are designed, not guessed. Here's our process: [[smile_design_text]]\n\nThe consult ([[consult_fee_text]]) is where you see what's actually possible for YOUR smile. We're open [[hours_text]] — reply anytime with questions.",
    },
    {
      step_number: 3,
      name: 'Education — veneers vs. alternatives',
      channel: 'sms',
      delay_minutes: 1 * DAY,
      ai_personalize: true,
      body_template:
        "Hi {{first_name}}, one thing patients love learning: veneers aren't the only path — sometimes whitening, bonding, or a mix gets the look for less. The consult sorts out which is right for you. What's the main thing you'd want to change?",
    },
    {
      step_number: 4,
      name: 'Trust — see the work',
      channel: 'email',
      delay_minutes: 2 * DAY,
      ai_personalize: true,
      subject: 'What your consult looks like',
      body_template:
        "Hi {{first_name}},\n\nHere's what happens when you come in: [[consult_flow_text]]\n\nYou'll leave with a real plan and real numbers — and you'll see cases like yours. We see cosmetic consults [[consult_days_text]]. Want a time?",
    },
    {
      step_number: 5,
      name: 'Money — frame the investment',
      channel: 'sms',
      delay_minutes: 2 * DAY,
      ai_personalize: true,
      body_template:
        "Hi {{first_name}}, fair warning: everyone asks about price first. [[price_band_text]] Most patients use financing to spread it out — we work with [[financing_partners]]. Want me to set up a consult so you get your exact number?",
    },
    {
      step_number: 6,
      name: 'Aspiration — the moments that matter',
      channel: 'email',
      delay_minutes: 3 * DAY,
      ai_personalize: true,
      subject: 'The photos you stop hiding from',
      body_template:
        "Hi {{first_name}},\n\nThe thing patients mention most after veneers isn't the mirror — it's photos, laughing without thinking about it, first impressions at work. If a version of that is what brought you to us, the consult is the first real step.\n\nReply here or call [[practice_phone]] whenever you're ready.",
    },
    {
      step_number: 7,
      name: 'Soft check-in',
      channel: 'sms',
      delay_minutes: 4 * DAY,
      ai_personalize: true,
      body_template:
        "Hi {{first_name}}, just checking in — no rush. If you're weighing it, I'm happy to answer anything (cost, process, how long it lasts). What would help most?",
    },
    {
      step_number: 8,
      name: 'Door open (final scheduled touch)',
      channel: 'email',
      delay_minutes: 9 * DAY,
      ai_personalize: true,
      subject: 'Your smile project, on your timeline',
      body_template:
        "Hi {{first_name}},\n\nI'll leave you be — your inquiry stays open with us, no expiration. When the timing's right for your smile project, just reply to this email and we'll pick it right back up.\n\n— [[practice_name]]",
    },
  ],
}
