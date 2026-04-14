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

  // ── OBJECTION HANDLING (DENTAL-SPECIFIC) ───────────────────────

  // Cost Objections
  {
    id: 'objection_cost_too_expensive',
    category: 'objection_handling',
    name: 'Cost Objection: "Too Expensive"',
    description: 'Address the sticker shock by reframing cost as long-term investment, comparing to alternatives, and introducing financing immediately. Send a testimonial from a patient who had the same concern.',
    when_to_use: 'Lead says "that\'s too much", "I can\'t afford it", "it\'s too expensive". This is the #1 objection — be prepared.',
    example_phrases: [
      'I totally get it — it\'s a significant investment. But let me ask you this: how much have you already spent on dentures, adhesives, relines, and dental work over the years? Most patients tell me All-on-4 actually saves them money in the long run.',
      'When you break it down to monthly payments, most of our patients pay around $250-350/month. That\'s less than a car payment — for something that lasts 20+ years and transforms your quality of life.',
      'Let me send you a video from one of our patients who had the exact same concern about cost. They\'ll tell you why they say it was the best investment they ever made.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'objection_cost_shopping_around',
    category: 'objection_handling',
    name: 'Cost Objection: "Shopping Around"',
    description: 'When the patient says they\'re comparing prices. Validate their research while positioning your practice as the quality choice. Warn about "dental tourism" and cheap implants failing.',
    when_to_use: 'Lead mentions they got a cheaper quote elsewhere or are comparison shopping.',
    example_phrases: [
      'That\'s really smart to compare — you should absolutely do your homework. Just make sure you\'re comparing apples to apples. Some practices quote per-implant and then add fees for the prosthetic, sedation, temporary teeth, and follow-ups. Our price includes everything.',
      'I\'d be cautious about significantly lower quotes. We see patients who went to a bargain provider and ended up paying double to fix the work. Dr. Samadian uses only premium materials and EACH case gets a custom surgical guide.',
      'Here\'s what I\'d suggest — come in for the free consultation, see our facility, meet the doctor, and THEN compare. Most patients who visit us don\'t look anywhere else.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'objection_cost_insurance',
    category: 'objection_handling',
    name: 'Cost Objection: "Does Insurance Cover It?"',
    description: 'Handle insurance questions honestly while pivoting to financing. Most dental insurance covers very little for implants.',
    when_to_use: 'Lead asks about insurance coverage.',
    example_phrases: [
      'Great question. Dental insurance typically covers a portion — usually $1,500-3,000 toward implant treatment. We\'ll work with your insurance to maximize your benefit, and our financing covers the rest with comfortable monthly payments.',
      'We accept most major dental insurance and we\'ll handle all the paperwork for you. But even without insurance, our financing options make it very affordable — most patients pay less than $300/month.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },

  // Fear/Anxiety Objections
  {
    id: 'objection_fear_pain',
    category: 'objection_handling',
    name: 'Fear Objection: "I\'m Afraid of the Pain"',
    description: 'Address dental anxiety and pain fears with sedation options, patient testimonials, and recovery reality. Proactively send a testimonial from a nervous patient.',
    when_to_use: 'Lead expresses fear of pain, needles, dental procedures, or has dental phobia.',
    example_phrases: [
      'I completely understand — dental anxiety is incredibly common, and it\'s nothing to be embarrassed about. That\'s exactly why we offer IV sedation. Most patients tell us they fell asleep and woke up with new teeth — they didn\'t feel a thing.',
      'I want to send you a video from one of our patients who was absolutely terrified before the procedure. They describe how easy it actually was — I think it\'ll really put your mind at ease.',
      'Our patients consistently rate the recovery as easier than a tooth extraction. Most are back to soft foods the next day and eating normally within a few weeks.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'objection_fear_failure',
    category: 'objection_handling',
    name: 'Fear Objection: "What If It Doesn\'t Work?"',
    description: 'Address fear of implant failure with success rates, warranty info, and long-term track record.',
    when_to_use: 'Lead worries about the procedure failing, implants not integrating, or complications.',
    example_phrases: [
      'That\'s a really smart question. All-on-4 has a 95-98% success rate — it\'s one of the most predictable procedures in dentistry. Dr. Samadian has placed thousands of implants with an exceptional track record.',
      'We stand behind our work. Your treatment includes follow-up care and monitoring to ensure everything heals perfectly. If there\'s ever an issue, we take care of it.',
      'Let me send you a testimonial from a patient who had the same concern — they\'re 5+ years in and couldn\'t be happier.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'objection_fear_sedation',
    category: 'objection_handling',
    name: 'Fear Objection: "I\'m Scared of Sedation"',
    description: 'Address sedation fears with safety info, monitoring details, and the option of different sedation levels.',
    when_to_use: 'Lead expresses fear of being "put under" or going to sleep.',
    example_phrases: [
      'That\'s completely valid. You\'re not alone — many patients have that concern. Here\'s what helps: you\'re continuously monitored by trained staff throughout the procedure. Your vitals are watched every second. And you have the option of lighter sedation where you\'re relaxed but still aware.',
      'It\'s not like hospital general anesthesia — it\'s more like a very relaxed, drowsy state. Patients describe it as "the best nap they\'ve ever had."',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },

  // Timing Objections
  {
    id: 'objection_timing_not_now',
    category: 'objection_handling',
    name: 'Timing Objection: "Not Right Now"',
    description: 'Handle "not the right time" by exploring the real reason, emphasizing cost of delay (bone loss), and lowering the commitment to just a consultation.',
    when_to_use: 'Lead says "maybe later", "now isn\'t a good time", "I\'m not ready yet".',
    example_phrases: [
      'I totally understand — timing matters. Can I ask what\'s making now feel off? Sometimes we can work around whatever\'s going on.',
      'Here\'s something important to know: the longer you wait, the more bone loss occurs, which can limit your options and make the procedure more complex and expensive down the road. The consultation is free and there\'s zero pressure — it just gives you information for whenever you ARE ready.',
      'The consultation is just 30-45 minutes and it\'s completely free. You\'d walk out with a personalized treatment plan, a 3D scan, and an exact cost — all totally no-pressure. That way when the timing IS right, you\'re ready to go.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'objection_timing_too_busy',
    category: 'objection_handling',
    name: 'Timing Objection: "I\'m Too Busy"',
    description: 'Handle schedule concerns by emphasizing same-day treatment, flexible scheduling, and minimal downtime.',
    when_to_use: 'Lead says they can\'t take time off work, have too much going on, busy schedule.',
    example_phrases: [
      'That\'s exactly why All-on-4 is so popular — you get your teeth in ONE visit. Most patients take a long weekend and they\'re back to work on Monday.',
      'We have early morning and weekend consultation slots specifically for busy professionals. The procedure itself is one day, and most patients only need 2-3 days of recovery.',
      'Think of it this way — you spend one day now, and you save yourself years of ongoing dental visits, denture adjustments, and hassle.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },

  // Spouse/Family Objections
  {
    id: 'objection_spouse_need_to_discuss',
    category: 'objection_handling',
    name: 'Spouse Objection: "I Need to Talk to My Spouse"',
    description: 'The classic stall. Validate it, but offer to include the spouse in the process. Offer to send info they can share.',
    when_to_use: 'Lead says they need to discuss with spouse, partner, or family member before deciding.',
    example_phrases: [
      'Absolutely — that\'s a big decision and your partner should be part of it. Would it help if I sent you some information you can share with them? I can also send a patient testimonial video so they can see real results.',
      'Your spouse is welcome to come to the consultation too! It\'s free, and having them there usually helps both of you feel more confident about the decision.',
      'I completely understand. Let me email you a summary of everything we discussed along with our financing options — that way you have all the facts to share. When would be a good time to follow up after you\'ve had a chance to talk?',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },

  // Trust/Credibility Objections
  {
    id: 'objection_trust_second_opinion',
    category: 'objection_handling',
    name: 'Trust Objection: "I Want a Second Opinion"',
    description: 'Validate their due diligence while positioning your practice as the authority. Offer the free consultation as their comparison benchmark.',
    when_to_use: 'Lead says they want to see other doctors or get a second opinion.',
    example_phrases: [
      'I actually encourage that — getting a second opinion is smart medicine. Our free consultation includes a 3D CT scan that most practices charge $500+ for. Use us as your benchmark, and then compare.',
      'Dr. Samadian welcomes second opinions. When patients compare, they almost always come back to us because of our technology, experience, and all-inclusive pricing.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'objection_trust_reviews',
    category: 'objection_handling',
    name: 'Trust Objection: "I\'ve Seen Bad Reviews About Implants"',
    description: 'Address negative stories about implants by distinguishing provider quality, materials, and technique. Send your own testimonials as counter-evidence.',
    when_to_use: 'Lead mentions horror stories, bad experiences from friends, or negative online reviews about implants in general.',
    example_phrases: [
      'I\'m glad you brought that up. Implant outcomes vary hugely based on the provider\'s experience and the materials used. That\'s why choosing the right practice matters so much. Dr. Samadian uses only premium implant systems and has thousands of successful cases.',
      'Let me send you some of our patient videos — hearing directly from people who went through it is the best way to know what your experience would actually be like with us.',
      'A lot of those negative experiences come from discount providers or dental tourism. We use guided surgery with 3D planning for every single case — it\'s a completely different level of precision.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },

  // ── PRE-EMPTIVE OBJECTION HANDLING ─────────────────────────────
  {
    id: 'preempt_cost_early',
    category: 'objection_handling',
    name: 'Pre-empt: Cost (Early in Conversation)',
    description: 'Proactively bring up financing and payment flexibility BEFORE the lead asks about cost. Neutralizes the biggest objection before it forms.',
    when_to_use: 'Mid-conversation, after establishing rapport but before they ask. Especially with price-sensitive profiles.',
    example_phrases: [
      'By the way, I should mention — most of our patients use our interest-free financing. It typically works out to about the cost of a daily coffee. So cost really shouldn\'t be a barrier to getting the smile you deserve.',
      'One thing patients love is that our consultation is completely free, and we include a $500 3D CT scan at no charge. We want you to have all the information before making any decisions.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'preempt_pain_early',
    category: 'objection_handling',
    name: 'Pre-empt: Pain/Fear (Early in Conversation)',
    description: 'Proactively address pain and recovery fears before the lead brings them up. Normalize the concern and provide reassurance.',
    when_to_use: 'When discussing the procedure, before the lead expresses fear. Especially with anxious profiles.',
    example_phrases: [
      'I should mention — because everyone wonders — the procedure is done under IV sedation, so you literally sleep through the whole thing. Most patients say the recovery was easier than they expected.',
      'Fun fact: our patients consistently tell us the recovery was easier than getting a tooth pulled. You\'re eating soft foods the next day.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'preempt_time_commitment',
    category: 'objection_handling',
    name: 'Pre-empt: Time Commitment',
    description: 'Address the "how long does this take" concern proactively by emphasizing same-day teeth and minimal downtime.',
    when_to_use: 'When discussing the procedure with working professionals or busy individuals.',
    example_phrases: [
      'One of the best parts about All-on-4 is you leave with teeth THE SAME DAY. The whole procedure is about 4-6 hours, and most people take a long weekend to recover. You could literally do this on a Friday and be back at work Monday.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'preempt_longevity',
    category: 'objection_handling',
    name: 'Pre-empt: "Is This Permanent?"',
    description: 'Address durability concerns before they arise. Implant-supported teeth last 20+ years — frame this as "the last dental decision you\'ll ever make."',
    when_to_use: 'When comparing to dentures or bridges. Especially with analytical types who think long-term.',
    example_phrases: [
      'Here\'s what makes this different from dentures — these are permanent. They don\'t come out, they don\'t slip, and with proper care they last 20+ years. This is the last dental decision you\'ll ever have to make.',
      'Think about it this way — in 20 years of dentures, you\'ll spend more on replacements, adhesives, relines, and dental visits than the one-time investment for permanent implants.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },

  // ── RE-CLOSING / LOOP CLOSURE STRATEGIES ───────────────────────
  {
    id: 'reclose_gentle_checkin',
    category: 're_engagement',
    name: 'Re-Close Stage 1: Gentle Check-In',
    description: 'The softest re-close. Simply check in with warmth and zero pressure. Re-establish the relationship before pushing.',
    when_to_use: 'First follow-up after lead went cold (3-7 days). Don\'t sell — just reconnect.',
    example_phrases: [
      'Hi [name]! Just checking in to see how you\'re doing. No pressure at all — just wanted to make sure you got the info you needed. 😊',
      'Hey [name], I was thinking about our conversation and wanted to see if any new questions came up. I\'m here whenever you\'re ready.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'reclose_value_add',
    category: 're_engagement',
    name: 'Re-Close Stage 2: Value-Add Touch',
    description: 'Provide something new and valuable — a testimonial, article, or relevant info — as a reason to reach out. Cross-channel tools are perfect here (text a video, email B&A photos).',
    when_to_use: 'Second follow-up (7-14 days after going cold). Give before you ask.',
    example_phrases: [
      'Hi [name]! I just saw this incredible transformation from one of our recent patients and immediately thought of you. Let me send it over — I think you\'ll love it.',
      'Hey [name], we just published a new patient story that I thought was really relevant to your situation. Mind if I email it to you?',
      'Quick update — we just launched a new financing option with even lower monthly payments. Thought you\'d want to know!',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'reclose_status_change',
    category: 're_engagement',
    name: 'Re-Close Stage 3: Status Change Trigger',
    description: 'Use something that changed as a legitimate reason to re-engage: new promotion, scheduling opening, financing update, new technology.',
    when_to_use: 'When there IS a genuine change to share (14-21 days cold). Never fabricate changes.',
    example_phrases: [
      'Great news — we just had a cancellation and have an opening this [day]. I know timing was a concern, so I wanted to give you first dibs before it fills up.',
      'Hi [name], I wanted to let you know our financing partner just lowered their rates. Your monthly payment would be even less than we discussed. Worth another look?',
      'We just upgraded our imaging technology — the new 3D scans are even more detailed. Your free consultation now includes this upgrade.',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'reclose_testimonial_nudge',
    category: 're_engagement',
    name: 'Re-Close Stage 4: Testimonial Nudge',
    description: 'Send a targeted testimonial that mirrors the lead\'s specific objection or situation. Use cross-channel tools to deliver the video/story. This is the "social proof push."',
    when_to_use: 'Lead has been cold 14-21 days and had a specific objection. Match testimonial to their concern.',
    example_phrases: [
      'I met a patient today who reminded me of you — she was nervous about the procedure too, and now she says it was the best decision she ever made. Let me send you her video.',
      '[name], I want to share something with you. This patient was in your EXACT situation — scared, unsure about cost, debating for months. Watch what happened. [send_testimonial]',
    ],
    setter_applicable: true,
    closer_applicable: true,
    risk_level: 'low',
  },
  {
    id: 'reclose_deadline_anchor',
    category: 're_engagement',
    name: 'Re-Close Stage 5: Deadline Anchor',
    description: 'Create a legitimate anchor point — appointment hold expiring, promotion ending, schedule filling. Give them a concrete reason to act NOW.',
    when_to_use: 'Lead has been cold 21-30 days. Needs a push with real constraints.',
    example_phrases: [
      'Hi [name], just a heads up — that consultation slot I was holding is going to open up to other patients by [date]. I wanted to give you the chance to claim it first.',
      'Our [promotion/financing special] ends [date]. I\'d hate for you to miss out — want me to hold a spot for you?',
      'I should let you know — Dr. Samadian\'s schedule is filling up through next quarter. If you want to get in before [timeframe], I\'d recommend booking your free consultation this week.',
    ],
    setter_applicable: false,
    closer_applicable: true,
    risk_level: 'medium',
  },
  {
    id: 'reclose_direct_ask',
    category: 're_engagement',
    name: 'Re-Close Stage 6: Direct Ask',
    description: 'Directly and respectfully ask what\'s holding them back. Be honest, vulnerable, and genuine. This breaks through the politeness barrier.',
    when_to_use: 'Lead has been cold 30+ days, multiple follow-ups unanswered. Time for radical honesty.',
    example_phrases: [
      'Hey [name], I want to be real with you for a second. I can tell you were interested when we first talked, and I want to make sure I\'m not the reason you haven\'t moved forward. Is there something I could have done differently?',
      '[name], I know I\'ve reached out a few times. I promise I\'m not trying to pressure you — I genuinely think this could change your life. Can you help me understand what\'s holding you back? Even if the answer is "I\'m not interested anymore" — I respect that.',
      'Sometimes patients tell me they\'re just not sure it\'s worth it. If that\'s where you are, let me ask you one question: if cost and fear weren\'t factors, would you do this tomorrow?',
    ],
    setter_applicable: false,
    closer_applicable: true,
    risk_level: 'medium',
  },
  {
    id: 'reclose_final_stand',
    category: 're_engagement',
    name: 'Re-Close Stage 7: Final Stand Offer',
    description: 'Make a compelling final offer — the best package, an exclusive promotion, or a one-time incentive. This is the "Hail Mary" before graceful release.',
    when_to_use: 'Last attempt before disengaging (45+ days cold). Must be a genuine offer, not manipulative.',
    example_phrases: [
      '[name], I\'m going to be straight with you. I spoke with the office and they approved something special for you — [offer]. This is a one-time courtesy, and I wanted you to have it before I close out your file.',
      'Before I stop reaching out, I wanted to make one last offer: free 3D scan, complimentary consultation, AND [incentive]. No strings, no pressure. If now still isn\'t the right time, I completely understand.',
    ],
    setter_applicable: false,
    closer_applicable: true,
    risk_level: 'high',
  },
  {
    id: 'reclose_graceful_release',
    category: 're_engagement',
    name: 'Re-Close Stage 8: Graceful Release',
    description: 'Know when to let go. Release the lead with warmth and an open door. Paradoxically, this often brings them BACK because it removes all pressure.',
    when_to_use: 'After all re-close stages have been exhausted. Lead has been non-responsive 60+ days.',
    example_phrases: [
      'Hi [name], I just wanted to let you know that I\'m going to stop reaching out for now. I don\'t want to be a bother, and I respect your decision. My door is always open — if anything changes, I\'m just a text away. Wishing you all the best! 😊',
      '[name], I\'ve really enjoyed getting to know you. I\'m going to give you some space, but I want you to know — whenever you\'re ready, even if it\'s a year from now, I\'ll be here. Take care!',
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
