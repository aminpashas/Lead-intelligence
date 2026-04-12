/**
 * Lead Personality Profiling System
 *
 * Analyzes lead communication style from conversation history
 * and categorizes them using a DISC-based personality framework
 * tailored for sales/healthcare contexts.
 */

// ── Primary Personality Types ───────────────────────────────
// Based on DISC + sales psychology research

export type PersonalityType =
  | 'analytical'     // Data-driven, methodical, asks detailed questions
  | 'driver'         // Decisive, action-oriented, time-conscious
  | 'expressive'     // Emotional, relationship-focused, storyteller
  | 'amiable'        // Friendly, supportive, needs reassurance
  | 'skeptic'        // Questions everything, needs social proof
  | 'researcher'     // Independent, self-informed, compares options

export type CommunicationTempo = 'instant' | 'fast' | 'moderate' | 'slow' | 'unresponsive'
export type MessageLength = 'brief' | 'moderate' | 'detailed' | 'verbose'
export type DecisionStyle = 'impulsive' | 'deliberate' | 'cautious' | 'avoidant'
export type TrustLevel = 'high' | 'building' | 'neutral' | 'guarded' | 'skeptical'
export type PriceSensitivity = 'price_driven' | 'value_conscious' | 'quality_focused' | 'premium_seeker'
export type EmotionalState = 'excited' | 'optimistic' | 'neutral' | 'anxious' | 'frustrated' | 'fearful'

export interface PersonalityProfile {
  // Primary classification
  primary_type: PersonalityType
  secondary_type: PersonalityType | null
  confidence: number // 0-100

  // Communication patterns
  communication_tempo: CommunicationTempo
  avg_response_time_minutes: number | null
  message_length: MessageLength
  avg_message_words: number | null

  // Behavioral traits (each 0-100)
  traits: {
    decisiveness: number
    price_sensitivity: number
    trust_level: number
    emotional_expressiveness: number
    detail_orientation: number
    urgency: number
    research_tendency: number
    social_proof_need: number
  }

  // Current emotional state
  emotional_state: EmotionalState
  decision_style: DecisionStyle

  // Communication preferences
  preferred_channel: 'sms' | 'email' | 'phone' | null
  best_contact_time: string | null // e.g., "morning", "evening"

  // Engagement signals
  objections_raised: string[]
  interests_expressed: string[]
  buying_signals: string[]

  // AI recommendations
  recommended_approach: string
  communication_tips: string[]

  // Metadata
  messages_analyzed: number
  last_analyzed_at: string
}

// ── Personality Type Metadata ────────────────────────────────

export const PERSONALITY_TYPES: Record<PersonalityType, {
  label: string
  emoji: string
  color: string
  description: string
  communication_tips: string[]
  do: string[]
  dont: string[]
}> = {
  analytical: {
    label: 'Analytical',
    emoji: '🔬',
    color: '#3b82f6', // blue
    description: 'Data-driven decision maker who values facts, research, and detailed information.',
    communication_tips: [
      'Provide statistics and success rates',
      'Share case studies with specific outcomes',
      'Be precise with costs and timelines',
      'Allow time for them to process information',
    ],
    do: ['Send detailed procedure breakdowns', 'Include clinical data', 'Offer comparison charts'],
    dont: ['Rush their decision', 'Use emotional appeals', 'Be vague about costs'],
  },
  driver: {
    label: 'Driver',
    emoji: '🎯',
    color: '#ef4444', // red
    description: 'Decisive, results-oriented person who values efficiency and direct communication.',
    communication_tips: [
      'Be concise and get to the point',
      'Focus on outcomes and results',
      'Offer clear next steps immediately',
      'Respect their time — no fluff',
    ],
    do: ['Send short, action-oriented messages', 'Provide clear CTAs', 'Offer fast-track options'],
    dont: ['Send long emails', 'Over-explain procedures', 'Be indecisive'],
  },
  expressive: {
    label: 'Expressive',
    emoji: '✨',
    color: '#f59e0b', // amber
    description: 'Enthusiastic communicator who values relationships, emotions, and personal connection.',
    communication_tips: [
      'Use warm, personal language',
      'Share patient success stories',
      'Show excitement about their journey',
      'Build rapport before business talk',
    ],
    do: ['Share before/after stories', 'Use emojis and warmth', 'Celebrate their progress'],
    dont: ['Be overly clinical', 'Skip the small talk', 'Focus only on numbers'],
  },
  amiable: {
    label: 'Amiable',
    emoji: '🤝',
    color: '#22c55e', // green
    description: 'Supportive and friendly person who values trust, comfort, and reassurance.',
    communication_tips: [
      'Be patient and reassuring',
      'Offer gentle follow-ups, not pressure',
      'Emphasize safety and comfort features',
      'Provide testimonials from similar patients',
    ],
    do: ['Check in regularly', 'Offer a warm team intro', 'Emphasize patient comfort'],
    dont: ['Use high-pressure tactics', 'Set artificial deadlines', 'Dismiss their concerns'],
  },
  skeptic: {
    label: 'Skeptic',
    emoji: '🤔',
    color: '#8b5cf6', // violet
    description: 'Cautious evaluator who questions claims and needs proof before committing.',
    communication_tips: [
      'Back every claim with evidence',
      'Offer references and reviews',
      'Address objections proactively',
      'Be transparent about risks and limitations',
    ],
    do: ['Share verified reviews', 'Offer money-back guarantees', 'Provide credentials'],
    dont: ['Make unsubstantiated claims', 'Avoid their questions', 'Be defensive'],
  },
  researcher: {
    label: 'Researcher',
    emoji: '📚',
    color: '#06b6d4', // cyan
    description: 'Self-informed seeker who has done extensive independent research and compares options.',
    communication_tips: [
      'Acknowledge their knowledge',
      'Provide advanced/technical details',
      'Differentiate your practice from competitors',
      'Respect their autonomy — advise, don\'t sell',
    ],
    do: ['Share unique differentiators', 'Offer advanced info they can\'t find online', 'Respect their research'],
    dont: ['Over-simplify', 'Give generic pitches', 'Ignore their existing knowledge'],
  },
}

// ── Analysis Signals ─────────────────────────────────────────

/** Keyword & pattern signals for personality classification */
export const ANALYSIS_PROMPTS = {
  system: `You are a behavioral psychologist specializing in patient communication analysis for dental practices.

Analyze the following conversation messages and create a personality profile for this lead.

Classification Framework:
- ANALYTICAL: Asks specific questions about procedures, costs, success rates, materials. Uses precise language.
- DRIVER: Short messages, wants quick answers, uses action words ("let's do it", "book it", "when can we start").
- EXPRESSIVE: Shares personal stories, uses emojis/exclamation marks, talks about feelings, relationship-focused.
- AMIABLE: Polite, apologetic, asks "is that okay?", seeks reassurance, worried about pain/comfort.
- SKEPTIC: Questions claims, mentions other options, asks "how do I know", brings up negative reviews.
- RESEARCHER: References specific procedures by name, mentions other practices, cites articles or videos.

For each trait, assign a score from 0-100:
- decisiveness: How quickly do they make decisions? (100 = instant, 0 = never decides)
- price_sensitivity: How focused are they on cost? (100 = extremely price-driven, 0 = doesn't mention cost)
- trust_level: How trusting are they? (100 = fully trusting, 0 = deeply skeptical)
- emotional_expressiveness: How emotionally expressive? (100 = very emotional, 0 = purely logical)
- detail_orientation: How detail-focused? (100 = wants every detail, 0 = big picture only)
- urgency: How urgent is their need? (100 = needs help now, 0 = no timeline)
- research_tendency: How much self-research? (100 = extensively informed, 0 = no prior research)
- social_proof_need: How much do they need validation? (100 = needs lots of reviews/testimonials, 0 = self-sufficient)

Respond ONLY with valid JSON matching this exact schema:
{
  "primary_type": "analytical|driver|expressive|amiable|skeptic|researcher",
  "secondary_type": "analytical|driver|expressive|amiable|skeptic|researcher|null",
  "confidence": 0-100,
  "communication_tempo": "instant|fast|moderate|slow|unresponsive",
  "message_length": "brief|moderate|detailed|verbose",
  "avg_message_words": number,
  "traits": {
    "decisiveness": 0-100,
    "price_sensitivity": 0-100,
    "trust_level": 0-100,
    "emotional_expressiveness": 0-100,
    "detail_orientation": 0-100,
    "urgency": 0-100,
    "research_tendency": 0-100,
    "social_proof_need": 0-100
  },
  "emotional_state": "excited|optimistic|neutral|anxious|frustrated|fearful",
  "decision_style": "impulsive|deliberate|cautious|avoidant",
  "objections_raised": ["string array of their specific objections"],
  "interests_expressed": ["string array of what they're interested in"],
  "buying_signals": ["string array of positive buying intent signals"],
  "recommended_approach": "1-2 sentence strategy recommendation",
  "communication_tips": ["3-4 specific tips for engaging this person"]
}`,
}
