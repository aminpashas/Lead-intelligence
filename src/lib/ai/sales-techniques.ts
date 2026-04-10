/**
 * Sales Technique Taxonomy
 *
 * Master reference of all sales techniques the AI agents can use.
 * The agents self-report which techniques they used in each response.
 * This is stored as constants (not DB) for speed and version control.
 */

export type TechniqueCategory =
  | 'closing'
  | 'objection_handling'
  | 'persuasion'
  | 'psychology'
  | 'engagement'
  | 're_engagement'
  | 'offer_creation'

export type SalesTechnique = {
  id: string
  category: TechniqueCategory
  name: string
  description: string
  when_to_use: string
  example_phrases: string[]
  setter_applicable: boolean
  closer_applicable: boolean
  risk_level: 'low' | 'medium' | 'high'
}

export type TechniqueUsage = {
  technique_id: string
  confidence: number
  effectiveness: 'effective' | 'neutral' | 'backfired' | 'too_early'
  context_note: string
}

export type LeadEngagementAssessment = {
  engagement_temperature: number
  resistance_level: number
  buying_readiness: number
  emotional_state: string
  recommended_approach: string
  techniques_to_try_next: string[]
  techniques_to_avoid: string[]
}

// ════════════════════════════════════════════════════════════════
// TECHNIQUE TAXONOMY
// ════════════════════════════════════════════════════════════════

export const SALES_TECHNIQUES: SalesTechnique[] = [
  // ── CLOSING TECHNIQUES ──────────────────────────────────────
  {
    id: 'closing_trial_close',
    category: 'closing',
    name: 'Trial Close',
    description: 'Test the waters with a soft commitment question to gauge readiness without pressure.',
    when_to_use: 'Engagement temperature ≥ 6, resistance ≤ 4. Use to check if lead is ready to move forward.',
    example_phrases: [
      'If we could get you in this week, would that work with your schedule?',
      'Does that sound like something you\'d want to explore further?',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'closing_assumptive',
    category: 'closing',
    name: 'Assumptive Close',
    description: 'Assume the sale is happening and move to logistics. Skips "if" and goes to "when/how".',
    when_to_use: 'Buying readiness ≥ 7, objections addressed. Lead has shown strong signals.',
    example_phrases: [
      'Great! Let me check what times we have available this week for your consultation.',
      'Perfect — I\'ll get your paperwork started. Do you prefer morning or afternoon?',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'medium',
  },
  {
    id: 'closing_urgency',
    category: 'closing',
    name: 'Urgency Close (Ethical)',
    description: 'Create legitimate urgency using real constraints — scheduling, financing deadlines, bone loss.',
    when_to_use: 'Buying readiness ≥ 5, lead is procrastinating. Only use with TRUE facts.',
    example_phrases: [
      'Our schedule fills up quickly — we have a few openings left this month.',
      'Your financing pre-approval is valid for 30 days, so timing matters.',
    ],
    setter_applicable: false,
    closer_applicable: true,
    risk_level: 'medium',
  },
  {
    id: 'closing_alternative_choice',
    category: 'closing',
    name: 'Alternative Choice Close',
    description: 'Offer two positive options instead of yes/no. Both options move forward.',
    when_to_use: 'Lead seems interested but indecisive. Remove the "no" option naturally.',
    example_phrases: [
      'Would Tuesday morning or Thursday afternoon work better for you?',
      'Would you prefer to start with the upper arch or do both at once?',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'closing_summary',
    category: 'closing',
    name: 'Summary Close',
    description: 'Summarize all the value/benefits discussed, then ask for commitment. Reinforces the "yes pile".',
    when_to_use: 'After thorough discussion. Lead has accumulated many reasons to proceed.',
    example_phrases: [
      'So we\'ve addressed the cost with financing, the recovery is just a few days, and you\'d be eating normally within weeks. Ready to take the next step?',
    ],
    setter_applicable: false,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'closing_hard',
    category: 'closing',
    name: 'Direct Ask / Hard Close',
    description: 'Directly and confidently ask for the commitment. Used when all objections are resolved.',
    when_to_use: 'Buying readiness ≥ 8, all objections addressed, strong rapport. Final push.',
    example_phrases: [
      'I think you\'re ready. Let\'s get you on the schedule — what day works?',
      'You\'ve done your research, you know this is right for you. Let\'s make it happen.',
    ],
    setter_applicable: false,
    closer_applicable: true,
    risk_level: 'high',
  },

  // ── OBJECTION HANDLING ──────────────────────────────────────
  {
    id: 'objection_feel_felt_found',
    category: 'objection_handling',
    name: 'Feel-Felt-Found',
    description: 'Validate the concern, normalize it with social proof, then share a positive outcome.',
    when_to_use: 'Lead expresses a common concern (cost, fear, timing). Works well with amiable/expressive types.',
    example_phrases: [
      'I totally understand how you feel. Many of our patients felt the same way. What they found was...',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'objection_boomerang',
    category: 'objection_handling',
    name: 'Boomerang',
    description: 'Turn the objection into a reason TO proceed. The concern becomes the selling point.',
    when_to_use: 'When the objection actually supports the case (e.g., "it\'s expensive" → "that\'s why financing exists").',
    example_phrases: [
      'That\'s exactly why we offer 0% financing — so cost isn\'t a barrier to the smile you deserve.',
      'The fact that you\'re concerned about recovery shows you take this seriously — and that\'s exactly the kind of patient who heals best.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'medium',
  },
  {
    id: 'objection_preemptive',
    category: 'objection_handling',
    name: 'Pre-emptive Rebuttal',
    description: 'Address a likely objection BEFORE the lead raises it. Shows confidence and removes the concern proactively.',
    when_to_use: 'When you can predict the objection based on lead profile (e.g., price-sensitive lead, anxious personality).',
    example_phrases: [
      'I know cost is usually the first question — so let me share upfront that most patients pay around $300/month with financing.',
      'Before you worry about pain — our patients consistently say it was easier than a tooth extraction.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'objection_acknowledge_bridge',
    category: 'objection_handling',
    name: 'Acknowledge-Bridge-Close',
    description: 'Acknowledge the concern genuinely, bridge to a positive reframe, then close with a next step.',
    when_to_use: 'Lead raises a legitimate concern that needs validation before pivoting.',
    example_phrases: [
      'That\'s a valid concern, and I appreciate you sharing it. Here\'s what I can tell you... [bridge] ...so the next step would be...',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },

  // ── PERSUASION ──────────────────────────────────────────────
  {
    id: 'persuasion_social_proof',
    category: 'persuasion',
    name: 'Social Proof',
    description: 'Reference other patients\' experiences, success stories, or statistics to build confidence.',
    when_to_use: 'Lead is uncertain or skeptical. Works especially well with amiable types who value consensus.',
    example_phrases: [
      'We\'ve helped over 500 patients just like you get their smile back.',
      'Most of our patients say they wish they\'d done it sooner.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'persuasion_scarcity_fomo',
    category: 'persuasion',
    name: 'Scarcity / FOMO',
    description: 'Highlight limited availability or time-sensitive opportunities. ONLY use with real constraints.',
    when_to_use: 'When there is genuine scarcity (limited appointment slots, expiring promotion, financing deadline).',
    example_phrases: [
      'We only have 3 consultation spots left this month.',
      'This promotional pricing is available through the end of the quarter.',
    ],
    setter_applicable: false,
    closer_applicable: true,
    risk_level: 'high',
  },
  {
    id: 'persuasion_authority',
    category: 'persuasion',
    name: 'Authority',
    description: 'Reference the doctor\'s expertise, credentials, success rate, or industry recognition.',
    when_to_use: 'Lead needs confidence in the provider. Analytical types respond well to credentials.',
    example_phrases: [
      'Dr. [name] has placed over 2,000 implants with a 98% success rate.',
      'Our practice is one of the top All-on-4 providers in the region.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'persuasion_reciprocity',
    category: 'persuasion',
    name: 'Reciprocity',
    description: 'Give value first (free info, resources, time) to create a sense of goodwill and obligation.',
    when_to_use: 'Early in the relationship. Establish yourself as a helpful resource, not a salesperson.',
    example_phrases: [
      'I put together some information specifically for your situation — no strings attached.',
      'Let me send you our recovery guide so you know exactly what to expect.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'persuasion_commitment_consistency',
    category: 'persuasion',
    name: 'Commitment & Consistency',
    description: 'Get small yeses that build toward the big yes. People want to be consistent with prior commitments.',
    when_to_use: 'Throughout the conversation. Chain small agreements into momentum.',
    example_phrases: [
      'You mentioned you\'re tired of dealing with dentures — is that right? [yes] And you\'d love to eat normally again? [yes] Then this consultation is the perfect next step.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'persuasion_liking',
    category: 'persuasion',
    name: 'Liking / Rapport',
    description: 'Build personal connection through common ground, genuine compliments, and warmth.',
    when_to_use: 'Always. People buy from people they like. Especially important with expressive and amiable types.',
    example_phrases: [
      'I love that you\'re doing this research — it shows how seriously you take your health.',
      'That sounds like a great reason to want this change!',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },

  // ── PSYCHOLOGY ──────────────────────────────────────────────
  {
    id: 'psychology_reverse',
    category: 'psychology',
    name: 'Reverse Psychology',
    description: 'Gently suggest they might not be ready, triggering their desire to prove they are.',
    when_to_use: 'Driver personality type, high motivation but stalling. Use sparingly and subtly.',
    example_phrases: [
      'This might not be the right time for you — and that\'s totally okay.',
      'All-on-4 isn\'t for everyone. It takes a real commitment to change your life.',
    ],
    setter_applicable: false,
    closer_applicable: true,
    risk_level: 'high',
  },
  {
    id: 'psychology_loss_aversion',
    category: 'psychology',
    name: 'Loss Aversion',
    description: 'Frame the cost of NOT acting — continued bone loss, worsening condition, missed life moments.',
    when_to_use: 'Lead is procrastinating. Frame what they lose by waiting, not just what they gain by acting.',
    example_phrases: [
      'Every year you wait, bone loss continues — which can limit your options down the road.',
      'How many more family dinners do you want to miss out on enjoying food?',
    ],
    setter_applicable: false,
    closer_applicable: true,
    risk_level: 'medium',
  },
  {
    id: 'psychology_anchoring',
    category: 'psychology',
    name: 'Price Anchoring',
    description: 'Present a higher reference point first so the actual price feels more reasonable.',
    when_to_use: 'Before discussing cost. Set expectations high, then present the actual investment.',
    example_phrases: [
      'Individual implants for a full arch can run $60,000+. All-on-4 achieves the same result for about half that.',
      'When you think about the cost of dentures over 20 years — replacements, adhesives, relines — it actually costs more than implants.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'psychology_framing',
    category: 'psychology',
    name: 'Positive Framing',
    description: 'Reframe the situation from negative to positive. Focus on transformation, not the problem.',
    when_to_use: 'Lead is focused on negatives (pain, cost, fear). Redirect to the positive outcome.',
    example_phrases: [
      'Instead of thinking about the procedure, imagine waking up and smiling confidently in the mirror.',
      'This isn\'t an expense — it\'s an investment in the next 20+ years of your life.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },

  // ── ENGAGEMENT ──────────────────────────────────────────────
  {
    id: 'engagement_mirroring',
    category: 'engagement',
    name: 'Mirroring',
    description: 'Match the lead\'s communication style, tone, energy, and language patterns.',
    when_to_use: 'Always. Adapt to formal/casual, brief/detailed, emotional/factual based on their style.',
    example_phrases: [],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'engagement_active_listening',
    category: 'engagement',
    name: 'Active Listening',
    description: 'Demonstrate you heard them by referencing specific things they said. Validate before responding.',
    when_to_use: 'After every patient message. Reference their exact words and concerns.',
    example_phrases: [
      'You mentioned you\'re embarrassed about your smile — I hear that, and it\'s a really common feeling.',
      'It sounds like the recovery time is your biggest concern. Let me address that specifically.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'engagement_open_questions',
    category: 'engagement',
    name: 'Open-Ended Questions',
    description: 'Ask questions that invite detailed responses, not yes/no. Deepens understanding and engagement.',
    when_to_use: 'During qualification and rapport building. Get the lead talking about their situation.',
    example_phrases: [
      'What made you start looking into dental implants?',
      'How is your current dental situation affecting your daily life?',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'engagement_storytelling',
    category: 'engagement',
    name: 'Storytelling',
    description: 'Share relevant patient stories (anonymized) that connect emotionally to their situation.',
    when_to_use: 'When building trust or addressing fears. Stories are more persuasive than facts alone.',
    example_phrases: [
      'We had a patient last month who was in a very similar situation — she hadn\'t smiled in photos for 10 years. After All-on-4, she couldn\'t stop smiling.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },

  // ── RE-ENGAGEMENT ───────────────────────────────────────────
  {
    id: 're_engagement_reclose',
    category: 're_engagement',
    name: 'Re-Close',
    description: 'After a failed close attempt, wait, then try again from a different angle with new information.',
    when_to_use: 'Lead said no or went silent after a close attempt. Come back with new value or angle.',
    example_phrases: [
      'I know we talked about this before — since then, we\'ve introduced a new financing option I thought you\'d want to know about.',
    ],
    setter_applicable: false,
    closer_applicable: true,
    risk_level: 'medium',
  },
  {
    id: 're_engagement_win_back',
    category: 're_engagement',
    name: 'Win-Back',
    description: 'Re-engage a cold or lost lead with something genuinely new — promotion, testimonial, life event trigger.',
    when_to_use: 'Lead has gone cold (14+ days no response). Provide genuine new value.',
    example_phrases: [
      'Hi [name]! Just wanted to share — we have a patient appreciation event coming up. Thought of you.',
      'Haven\'t heard from you in a while — just checking in. No pressure at all.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 're_engagement_pattern_interrupt',
    category: 're_engagement',
    name: 'Pattern Interrupt',
    description: 'Break the expected pattern to recapture attention. Say something unexpected or use humor.',
    when_to_use: 'Lead is giving repetitive non-committal responses or conversations feel stale.',
    example_phrases: [
      'Okay, I\'m going to be real with you for a second — what\'s the ONE thing holding you back?',
      'I have a confession... I\'ve been thinking about your case and I have an idea.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'medium',
  },
  {
    id: 're_engagement_new_angle',
    category: 're_engagement',
    name: 'New Angle',
    description: 'Approach the same goal from a completely different angle — health instead of cosmetic, family instead of self.',
    when_to_use: 'Current approach isn\'t resonating. Pivot to a different motivation or value proposition.',
    example_phrases: [
      'We\'ve talked about the cosmetic side, but I haven\'t mentioned — implants actually prevent the jawbone deterioration that happens with missing teeth.',
      'Have you thought about how this would affect your time with your grandkids? Being able to eat whatever they\'re having at family dinners?',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },

  // ── OFFER CREATION ──────────────────────────────────────────
  {
    id: 'offer_value_stack',
    category: 'offer_creation',
    name: 'Value Stack',
    description: 'List everything included in the treatment to make the total feel like incredible value.',
    when_to_use: 'When discussing price. Stack the value so the cost feels small relative to what they get.',
    example_phrases: [
      'Your treatment includes the CT scan ($500 value), surgical guide, all 4 implants, sedation, temporary teeth same day, all follow-ups, AND your final zirconia bridge — all in one price.',
    ],
    setter_applicable: false,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'offer_limited_time',
    category: 'offer_creation',
    name: 'Limited-Time Offer',
    description: 'Present a time-bound promotion or incentive. ONLY use if the promotion is real.',
    when_to_use: 'When a genuine promotion exists. Creates ethical urgency.',
    example_phrases: [
      'We\'re running a spring special — $2,000 off per arch through the end of the month.',
      'We have a complimentary 3D scan promotion this quarter — normally $500.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'medium',
  },
  {
    id: 'offer_custom_package',
    category: 'offer_creation',
    name: 'Custom Package',
    description: 'Tailor the offer to the lead\'s specific needs and concerns. Makes them feel seen.',
    when_to_use: 'Lead has specific concerns (cost, fear, timing) that a custom approach could address.',
    example_phrases: [
      'Based on your situation, here\'s what I\'d recommend — start with one arch now, and we can do the second when you\'re ready.',
      'Since timing is flexible for you, we could spread the treatment over two phases to keep the monthly payments lower.',
    ],
    setter_applicable: false,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'offer_financing_frame',
    category: 'offer_creation',
    name: 'Financing Frame',
    description: 'Reframe the total cost as a manageable monthly payment. Makes the number feel smaller.',
    when_to_use: 'When cost is the primary objection. Shift from total to monthly.',
    example_phrases: [
      'Most patients are surprised — it works out to about $300/month with financing. Less than a lot of people pay for cable and streaming.',
      'With our 0% financing, you\'re looking at the cost of a daily coffee for a smile that lasts 20+ years.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
]

// ════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════

export const TECHNIQUE_CATEGORIES: Record<TechniqueCategory, string> = {
  closing: 'Closing',
  objection_handling: 'Objection Handling',
  persuasion: 'Persuasion',
  psychology: 'Psychology',
  engagement: 'Engagement',
  re_engagement: 'Re-Engagement',
  offer_creation: 'Offer Creation',
}

export const TECHNIQUE_CATEGORY_COLORS: Record<TechniqueCategory, string> = {
  closing: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  objection_handling: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  persuasion: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  psychology: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  engagement: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  re_engagement: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  offer_creation: 'bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-300',
}

export function getTechniquesForAgent(agentType: 'setter' | 'closer'): SalesTechnique[] {
  return SALES_TECHNIQUES.filter((t) =>
    agentType === 'setter' ? t.setter_applicable : t.closer_applicable
  )
}

export function getTechniqueById(id: string): SalesTechnique | undefined {
  return SALES_TECHNIQUES.find((t) => t.id === id)
}

export function formatTechniquesForPrompt(techniques: SalesTechnique[]): string {
  const byCategory = new Map<TechniqueCategory, SalesTechnique[]>()
  for (const t of techniques) {
    const list = byCategory.get(t.category) || []
    list.push(t)
    byCategory.set(t.category, list)
  }

  const sections: string[] = []
  for (const [category, techs] of byCategory) {
    const label = TECHNIQUE_CATEGORIES[category]
    const items = techs
      .map((t) => `  - **${t.id}** (${t.name}): ${t.description} [Risk: ${t.risk_level}]`)
      .join('\n')
    sections.push(`### ${label}\n${items}`)
  }

  return sections.join('\n\n')
}
