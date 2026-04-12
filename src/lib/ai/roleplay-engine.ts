/**
 * Role Play Training Engine
 *
 * Generates AI responses for role-play training sessions.
 * Supports two modes:
 * - User as Patient → AI plays as Treatment Coordinator (Setter/Closer)
 * - User as TC → AI plays as a realistic Patient persona
 *
 * Also handles post-session analysis: extracting training examples
 * and generating session summaries.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  AIRolePlayMessage,
  AIRolePlaySession,
  RolePlayRole,
  RolePlayAgentTarget,
  RolePlayScenario,
} from '@/types/database'
import {
  getActiveMemories,
  getRelevantKnowledge,
  buildTrainingSystemPrompt,
} from './training-context'

function getAnthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
}

// ════════════════════════════════════════════════════════════════
// BUILT-IN SCENARIOS
// ════════════════════════════════════════════════════════════════

export const BUILT_IN_SCENARIOS: RolePlayScenario[] = [
  {
    id: 'new-patient-sms',
    name: 'New Patient Inquiry (SMS)',
    description: 'A new lead just submitted a form and is receiving their first text. They\'re curious but cautious.',
    category: 'new_patient',
    agent_target: 'setter',
    patient_persona: {
      name: 'Sarah',
      personality_type: 'analytical',
      dental_condition: 'Failing teeth, considering options',
      emotional_state: 'curious but cautious',
      objections: ['Want to research more first', 'Concerned about recovery time'],
      budget_concern: 'Wants to understand costs before committing',
      custom_notes: 'Has been wearing a partial denture for 3 years. Saw an ad on Facebook.',
    },
    difficulty: 'easy',
    is_built_in: true,
  },
  {
    id: 'cost-objection',
    name: 'Cost Objection Handling',
    description: 'Patient loves the idea of All-on-4 but has significant cost concerns. Tests your ability to handle price objections with empathy.',
    category: 'objection',
    agent_target: 'closer',
    patient_persona: {
      name: 'Mike',
      personality_type: 'driver',
      dental_condition: 'Missing all upper teeth, wears full denture',
      emotional_state: 'frustrated with dentures but worried about cost',
      objections: ['$25k is a lot of money', 'My insurance won\'t cover it', 'I saw cheaper options online'],
      budget_concern: 'Budget is tight, interested in financing but nervous about monthly payments',
      custom_notes: 'Already had a consultation. Knows he wants it but can\'t justify the price yet. Works as a contractor.',
    },
    difficulty: 'hard',
    is_built_in: true,
  },
  {
    id: 'anxious-patient',
    name: 'Anxious / Fearful Patient',
    description: 'Patient has severe dental anxiety. They want implants but are terrified of the procedure. Tests empathy and reassurance skills.',
    category: 'objection',
    agent_target: 'setter',
    patient_persona: {
      name: 'Linda',
      personality_type: 'amiable',
      dental_condition: 'Multiple failing teeth, needs full arch',
      emotional_state: 'anxious, fearful of pain and surgery',
      objections: ['I\'m terrified of dental procedures', 'What if something goes wrong?', 'I need someone to hold my hand through this'],
      budget_concern: 'Money is secondary to fear — she needs to feel safe first',
      custom_notes: 'Had a traumatic dental experience as a child. Hasn\'t been to a dentist in 5 years. Her daughter recommended looking into implants.',
    },
    difficulty: 'medium',
    is_built_in: true,
  },
  {
    id: 'price-shopper',
    name: 'Price Shopper Comparison',
    description: 'Patient is comparing your practice with 2-3 competitors. They\'re direct and to the point — just want the best deal.',
    category: 'objection',
    agent_target: 'setter',
    patient_persona: {
      name: 'Dave',
      personality_type: 'driver',
      dental_condition: 'Needs full upper and lower implants',
      emotional_state: 'pragmatic, no-nonsense',
      objections: ['Another place quoted me $15k per arch', 'Why should I choose you?', 'Can you match their price?'],
      budget_concern: 'Has budget but wants the best value — not necessarily cheapest',
      custom_notes: 'Has already visited 2 other practices. Knows his condition well. Just wants numbers and facts.',
    },
    difficulty: 'hard',
    is_built_in: true,
  },
  {
    id: 'post-consult-followup',
    name: 'Post-Consultation Follow-Up',
    description: 'Patient had a great consultation 3 days ago but hasn\'t booked treatment. They need a gentle nudge without pressure.',
    category: 'follow_up',
    agent_target: 'closer',
    patient_persona: {
      name: 'Karen',
      personality_type: 'expressive',
      dental_condition: 'All-on-4 candidate, treatment plan presented',
      emotional_state: 'excited but overthinking',
      objections: ['I need to talk to my husband', 'Just want to sleep on it', 'What if I\'m not a good candidate after all?'],
      budget_concern: 'Pre-approved for financing at $450/month — comfortable with it',
      custom_notes: 'Loved the doctor. Said "this could change my life." But hasn\'t called back. Husband is supportive but wasn\'t at the consultation.',
    },
    difficulty: 'medium',
    is_built_in: true,
  },
  {
    id: 'no-show-reengage',
    name: 'No-Show Re-engagement',
    description: 'Patient missed their consultation without calling. Need to re-engage without making them feel guilty.',
    category: 're_engagement',
    agent_target: 'setter',
    patient_persona: {
      name: 'James',
      personality_type: 'amiable',
      dental_condition: 'Denture problems, exploring implants',
      emotional_state: 'embarrassed about missing appointment, feels guilty',
      objections: ['I got busy', 'Something came up', 'I\'m not sure I\'m ready'],
      budget_concern: 'Cost wasn\'t the issue — it was cold feet',
      custom_notes: 'Was very enthusiastic in text conversations. Qualified well. Just got nervous the day of. Has no-showed once before at another dentist.',
    },
    difficulty: 'easy',
    is_built_in: true,
  },
  {
    id: 'closing-hot-lead',
    name: 'Closing a Hot Lead',
    description: 'Patient is ready to commit but needs the final push. All objections addressed, financing approved. Time to close.',
    category: 'closing',
    agent_target: 'closer',
    patient_persona: {
      name: 'Maria',
      personality_type: 'expressive',
      dental_condition: 'Full upper arch, ready for treatment',
      emotional_state: 'excited but needs validation',
      objections: [],
      budget_concern: 'Financing approved, comfortable with monthly payment',
      custom_notes: 'Everything is aligned. She just needs to hear "you\'re making the right choice" and know the next steps clearly. Her daughter is getting married in 6 months — she wants her new smile for the wedding.',
    },
    difficulty: 'easy',
    is_built_in: true,
  },
]

// ════════════════════════════════════════════════════════════════
// PATIENT PERSONA PROMPT (AI plays as patient)
// ════════════════════════════════════════════════════════════════

function buildPatientPersonaPrompt(
  session: Pick<AIRolePlaySession, 'patient_persona' | 'scenario_description' | 'agent_target'>
): string {
  const persona = session.patient_persona

  return `You are role-playing as a PATIENT who is interacting with a dental implant practice's treatment coordinator.

═══ YOUR CHARACTER ═══

Name: ${persona?.name || 'Alex'}
Personality type: ${persona?.personality_type || 'friendly but cautious'}
Dental condition: ${persona?.dental_condition || 'Considering dental implants'}
Current emotional state: ${persona?.emotional_state || 'curious but uncertain'}
Budget concerns: ${persona?.budget_concern || 'Wants to understand costs'}

${persona?.objections && persona.objections.length > 0 ? `═══ YOUR OBJECTIONS (bring these up naturally) ═══

${persona.objections.map((o, i) => `${i + 1}. "${o}"`).join('\n')}

Bring these up naturally throughout the conversation — don't dump them all at once. React realistically to how the TC handles each one.` : ''}

${persona?.custom_notes ? `═══ BACKGROUND ═══\n\n${persona.custom_notes}` : ''}

${session.scenario_description ? `═══ SCENARIO ═══\n\n${session.scenario_description}` : ''}

═══ HOW TO PLAY THIS CHARACTER ═══

1. Stay in character at ALL times. You are the patient, not an AI.
2. React realistically — if the TC says something good, warm up. If they're pushy, pull back.
3. Don't make it too easy OR too hard. Be a realistic patient with real concerns.
4. Use casual, natural language — you're texting or talking to a dental office, not writing an essay.
5. Show emotions: excitement, nervousness, frustration, hope — whatever fits the moment.
6. If the TC handles an objection well, acknowledge it naturally. Don't just repeat the objection.
7. If the TC does something great, reward it with engagement. If they make a mistake, react as a real patient would.
8. Keep messages conversational length — not too long, not too short. Match the energy of text/chat.
9. ${persona?.personality_type === 'analytical' ? 'Ask detailed questions. Want data and specifics.' :
    persona?.personality_type === 'driver' ? 'Be direct and results-focused. Don\'t waste time.' :
    persona?.personality_type === 'expressive' ? 'Be emotional and share personal stories. Connect on feelings.' :
    persona?.personality_type === 'amiable' ? 'Be warm and agreeable but need reassurance. Avoid conflict.' :
    'Be naturally conversational.'}

═══ IMPORTANT ═══

- You are training a human treatment coordinator. Your job is to be a REALISTIC practice partner.
- Do NOT break character. Do NOT provide coaching or feedback. Just BE the patient.
- Respond only with what the patient would say. No meta-commentary.`
}

// ════════════════════════════════════════════════════════════════
// TC PROMPT (AI plays as Treatment Coordinator)
// ════════════════════════════════════════════════════════════════

function buildTCPrompt(
  agentTarget: RolePlayAgentTarget,
  memories: { title: string; content: string; category: string }[],
  articles: { title: string; content: string }[],
  scenarioDescription: string | null
): string {
  const role = agentTarget === 'setter'
    ? `You are the SETTER — a warm, professional patient coordinator. Your job is to qualify leads, build rapport, and book consultations.`
    : `You are the CLOSER — a senior treatment coordinator. Your job is to reinforce treatment value, handle objections, guide financing, and help patients commit.`

  let basePrompt = `You are role-playing as a Treatment Coordinator for an All-on-4 dental implant practice. A real person is playing the PATIENT to practice and train you.

═══ YOUR ROLE ═══

${role}

${scenarioDescription ? `═══ SCENARIO CONTEXT ═══\n\n${scenarioDescription}\n` : ''}

═══ HOW TO RESPOND ═══

1. Respond as the treatment coordinator would in a real conversation.
2. Be warm, professional, and empathetic.
3. Use natural conversational language — this is text/chat, not a formal letter.
4. Apply sales techniques naturally — don't be obvious about it.
5. Keep responses concise but substantive.
6. Ask thoughtful questions to qualify and engage.
7. Never be pushy or use high-pressure tactics.
8. Follow HIPAA guidelines — don't share or ask for sensitive info via text.

═══ RESPOND WITH JUST YOUR MESSAGE ═══

Do NOT include JSON, metadata, or any structure. Just respond as the TC would in a text conversation.`

  // Add training memories and knowledge
  if (memories.length > 0) {
    const memorySection = memories
      .map((m) => `### ${m.title} [${m.category}]\n${m.content}`)
      .join('\n\n')
    basePrompt += `\n\n═══ TRAINING INSTRUCTIONS ═══\n\nFollow these guidelines (these come from your training):\n\n${memorySection}`
  }

  if (articles.length > 0) {
    const knowledgeSection = articles
      .map((a) => `### ${a.title}\n${a.content}`)
      .join('\n\n')
    basePrompt += `\n\n═══ KNOWLEDGE BASE ═══\n\nReference this knowledge when relevant:\n\n${knowledgeSection}`
  }

  return basePrompt
}

// ════════════════════════════════════════════════════════════════
// GENERATE ROLE-PLAY RESPONSE
// ════════════════════════════════════════════════════════════════

export async function generateRolePlayResponse(
  supabase: SupabaseClient,
  orgId: string,
  session: Pick<AIRolePlaySession, 'user_role' | 'agent_target' | 'patient_persona' | 'scenario_description' | 'messages'>
): Promise<string> {
  const anthropic = getAnthropic()

  // Build the system prompt based on who the AI is playing
  let systemPrompt: string

  if (session.user_role === 'treatment_coordinator') {
    // User is TC → AI plays as patient
    systemPrompt = buildPatientPersonaPrompt(session)
  } else {
    // User is patient → AI plays as TC
    const [memories, articles] = await Promise.all([
      getActiveMemories(supabase, orgId),
      getRelevantKnowledge(supabase, orgId, session.messages[session.messages.length - 1]?.content || ''),
    ])
    systemPrompt = buildTCPrompt(
      session.agent_target,
      memories.map(m => ({ title: m.title, content: m.content, category: m.category })),
      articles.map(a => ({ title: a.title, content: a.content })),
      session.scenario_description
    )
  }

  // Format messages for Claude
  const messages = session.messages.map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }))

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  })

  const text = response.content.find(b => b.type === 'text')
  return text && text.type === 'text' ? text.text : ''
}

// ════════════════════════════════════════════════════════════════
// RETRY WITH COURSE CORRECTION
// ════════════════════════════════════════════════════════════════

/**
 * Regenerates an AI response, incorporating the user's feedback about
 * what was wrong with the previous attempt. The AI sees its old response
 * and the correction instructions, then produces a better version.
 */
export async function generateRolePlayRetry(
  supabase: SupabaseClient,
  orgId: string,
  session: Pick<AIRolePlaySession, 'user_role' | 'agent_target' | 'patient_persona' | 'scenario_description' | 'messages'>,
  previousAttempt: string,
  feedback: string | null
): Promise<string> {
  const anthropic = getAnthropic()

  // Build the base system prompt (same as regular response)
  let systemPrompt: string

  if (session.user_role === 'treatment_coordinator') {
    systemPrompt = buildPatientPersonaPrompt(session)
  } else {
    const [memories, articles] = await Promise.all([
      getActiveMemories(supabase, orgId),
      getRelevantKnowledge(supabase, orgId, session.messages[session.messages.length - 1]?.content || ''),
    ])
    systemPrompt = buildTCPrompt(
      session.agent_target,
      memories.map(m => ({ title: m.title, content: m.content, category: m.category })),
      articles.map(a => ({ title: a.title, content: a.content })),
      session.scenario_description
    )
  }

  // Add retry instructions to the system prompt
  const retryInstructions = feedback
    ? `\n\n═══ COURSE CORRECTION ═══

Your previous response was rejected by the trainer. Here is what you said:

"${previousAttempt}"

The trainer's feedback on what to change:
"${feedback}"

Generate a NEW response that addresses the trainer's feedback. Do NOT repeat the same approach. Apply the correction and try a different angle.
Important: Respond ONLY with the corrected message. No explanations or meta-commentary.`
    : `\n\n═══ RETRY ═══

Your previous response was rejected by the trainer. Here is what you said:

"${previousAttempt}"

The trainer wants you to try a DIFFERENT approach. Generate a substantially different response — different tone, different angle, different strategy. Don't just rephrase the same thing.
Important: Respond ONLY with the new message. No explanations or meta-commentary.`

  systemPrompt += retryInstructions

  // Build messages WITHOUT the last assistant message (we're replacing it)
  const messages = session.messages
    .filter(m => !(m.role === 'assistant' && m.content === previousAttempt))
    .map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }))

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  })

  const text = response.content.find(b => b.type === 'text')
  return text && text.type === 'text' ? text.text : ''
}

// ════════════════════════════════════════════════════════════════
// EXTRACT TRAINING EXAMPLES
// ════════════════════════════════════════════════════════════════

export async function extractTrainingExamples(
  session: AIRolePlaySession
): Promise<Array<{
  category: string
  scenario_context: string
  patient_message: string
  ideal_response: string
  coaching_notes: string | null
}>> {
  const anthropic = getAnthropic()

  // Find golden examples (starred messages)
  const goldenPairs: Array<{ patient: string; tc: string; note: string | null }> = []

  for (let i = 0; i < session.messages.length; i++) {
    const msg = session.messages[i]
    if (msg.is_golden_example) {
      // Find the patient/TC pair around this golden message
      if (msg.acting_as === 'treatment_coordinator' && i > 0) {
        // This TC response was golden — pair with previous patient message
        goldenPairs.push({
          patient: session.messages[i - 1]?.content || '',
          tc: msg.content,
          note: msg.coaching_note,
        })
      } else if (msg.acting_as === 'patient' && i < session.messages.length - 1) {
        // This patient message was golden — pair with next TC response
        goldenPairs.push({
          patient: msg.content,
          tc: session.messages[i + 1]?.content || '',
          note: msg.coaching_note,
        })
      }
    }
  }

  // Also find pairs with good ratings
  for (let i = 0; i < session.messages.length; i++) {
    const msg = session.messages[i]
    if (msg.rating === 'good' && msg.acting_as === 'treatment_coordinator' && i > 0) {
      const alreadyIncluded = goldenPairs.some(p => p.tc === msg.content)
      if (!alreadyIncluded) {
        goldenPairs.push({
          patient: session.messages[i - 1]?.content || '',
          tc: msg.content,
          note: msg.coaching_note,
        })
      }
    }
  }

  if (goldenPairs.length === 0) {
    // If no golden examples, ask AI to identify the best exchanges
    const conversationText = session.messages
      .map(m => `[${m.acting_as === 'patient' ? 'PATIENT' : 'TC'}]: ${m.content}`)
      .join('\n\n')

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: `You are a dental sales training analyst. Analyze this role-play conversation between a patient and treatment coordinator. Extract the 3-5 best exchanges that demonstrate excellent communication, objection handling, or rapport building. These will be used as training examples.

Respond with ONLY a JSON array:
[
  {
    "category": "ideal_response|objection_handling|rapport_building|closing_technique|patient_education|follow_up|general",
    "scenario_context": "Brief description of the situation",
    "patient_message": "What the patient said",
    "ideal_response": "The TC's excellent response",
    "coaching_notes": "Why this is a good example"
  }
]`,
      messages: [{ role: 'user', content: conversationText }],
    })

    const text = response.content.find(b => b.type === 'text')
    const responseText = text && text.type === 'text' ? text.text : '[]'

    try {
      const jsonMatch = responseText.match(/\[[\s\S]*\]/)
      return jsonMatch ? JSON.parse(jsonMatch[0]) : []
    } catch {
      return []
    }
  }

  // Convert golden pairs to training examples using AI for categorization
  const pairsText = goldenPairs
    .map((p, i) => `Example ${i + 1}:\nPatient: "${p.patient}"\nTC: "${p.tc}"${p.note ? `\nCoaching note: ${p.note}` : ''}`)
    .join('\n\n')

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    system: `You are a dental sales training analyst. For each marked exchange, create a structured training example. Keep the patient message and TC response exactly as-is — just add categorization and context.

Respond with ONLY a JSON array:
[
  {
    "category": "ideal_response|objection_handling|rapport_building|closing_technique|patient_education|follow_up|general",
    "scenario_context": "Brief description of when this response would be useful",
    "patient_message": "The exact patient message",
    "ideal_response": "The exact TC response",
    "coaching_notes": "Why this works well + any coaching note provided"
  }
]`,
    messages: [{ role: 'user', content: `Role play scenario: ${session.scenario_description || 'General training'}\nAgent: ${session.agent_target}\n\n${pairsText}` }],
  })

  const text = response.content.find(b => b.type === 'text')
  const responseText = text && text.type === 'text' ? text.text : '[]'

  try {
    const jsonMatch = responseText.match(/\[[\s\S]*\]/)
    return jsonMatch ? JSON.parse(jsonMatch[0]) : []
  } catch {
    return []
  }
}

// ════════════════════════════════════════════════════════════════
// GENERATE SESSION SUMMARY
// ════════════════════════════════════════════════════════════════

export async function generateSessionSummary(
  session: AIRolePlaySession
): Promise<string> {
  const anthropic = getAnthropic()

  const conversationText = session.messages
    .map(m => `[${m.acting_as === 'patient' ? 'PATIENT' : 'TC'}]: ${m.content}`)
    .join('\n\n')

  const goldenCount = session.messages.filter(m => m.is_golden_example).length
  const goodRatings = session.messages.filter(m => m.rating === 'good').length
  const badRatings = session.messages.filter(m => m.rating === 'bad').length

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: `You are a dental sales training coach. Summarize this role-play training session. Be constructive and specific.

Include:
1. What was practiced (scenario, skills)
2. What went well (specific examples)
3. Areas for improvement (specific, actionable)
4. Key techniques demonstrated
5. Overall assessment

Keep it concise — 3-4 paragraphs max. Write in a coaching tone, not academic.`,
    messages: [{
      role: 'user',
      content: `Session type: User played as ${session.user_role}, training the ${session.agent_target} agent
Scenario: ${session.scenario_description || 'Free-form training'}
Messages: ${session.messages.length}
Golden examples marked: ${goldenCount}
Good ratings: ${goodRatings}, Bad ratings: ${badRatings}

Conversation:
${conversationText}`,
    }],
  })

  const text = response.content.find(b => b.type === 'text')
  return text && text.type === 'text' ? text.text : 'Session summary could not be generated.'
}
