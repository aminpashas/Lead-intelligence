/**
 * Conversation Analyst Agent
 *
 * Analyzes each conversation to rate:
 * - Emotional dynamics and tone
 * - Sales quality (too pushy? not enough?)
 * - Patient engagement signals
 * - Staff coaching opportunities
 * - Red flags and buying signals
 * - HIPAA compliance of the conversation
 *
 * Runs after each conversation ends or on-demand.
 * Results feed into staff performance dashboards and coaching.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildSafeConversationHistory, buildSafeLeadContext, detectPHI, logHIPAAEvent } from './hipaa'

function getAnthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
}

// ════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════

export type ConversationAnalysis = {
  // Overall Scores (0-10)
  emotional_score: number
  engagement_score: number
  trust_score: number
  urgency_score: number

  // Tone
  patient_tone: string
  staff_tone: string
  tone_alignment: string

  // Sales Quality (0-10)
  sales_pressure_level: number
  empathy_level: number
  active_listening_score: number
  objection_handling_quality: number
  rapport_building_score: number

  // Patient Signals
  patient_openness: number
  patient_buying_signals: number
  patient_resistance: number
  response_enthusiasm: string

  // Dynamics
  conversation_flow: string
  turning_points: Array<{ message_index: number; type: string; description: string }>

  // Flags
  red_flags: Array<{ flag: string; severity: string; message_index: number }>
  opportunities: Array<{ opportunity: string; type: string; message_index: number }>

  // Staff Coaching
  coaching_notes: string
  improvement_areas: string[]
  things_done_well: string[]

  // HIPAA
  phi_detected: boolean
  phi_details: Array<{ category: string; message_index: number; remediation: string }>
  compliance_score: number
  compliance_issues: Array<{ issue: string; severity: string }>
}

// ════════════════════════════════════════════════════════════════
// SYSTEM PROMPT
// ════════════════════════════════════════════════════════════════

const CONVERSATION_ANALYST_PROMPT = `You are an expert conversation analyst specializing in dental implant practice patient communications.

Your job is to analyze staff-patient conversations and provide actionable insights across multiple dimensions. You are part coach, part quality assurance, and part sales strategist.

## Analysis Dimensions

### 1. Emotional Intelligence (0-10 each)
- **Emotional Score**: Overall emotional quality of the conversation. High = both parties feel good.
- **Engagement Score**: How invested is the patient? Are they asking questions? Sharing details?
- **Trust Score**: Is trust building or eroding? Look for vulnerability, openness, confirmation.
- **Urgency Score**: How urgently does the patient want/need treatment?

### 2. Tone Analysis
- **Patient Tone**: warm, neutral, cold, anxious, excited, frustrated, defensive, hopeful, skeptical
- **Staff Tone**: professional, empathetic, pushy, cold, warm, aggressive, scripted, authentic
- **Tone Alignment**: Are they matched? Mismatched? Improving? Deteriorating?

### 3. Sales Quality (0-10 each)
- **Sales Pressure**: 0 = zero pressure, 5 = balanced, 10 = aggressive/pushy
  - IDEAL: 3-5 for most patients, 1-3 for anxious patients
- **Empathy Level**: Does staff acknowledge feelings, validate concerns, show understanding?
- **Active Listening**: Does staff reference what patient said? Ask follow-up questions?
- **Objection Handling**: When objections arise, how well are they addressed?
- **Rapport Building**: Personal connections, warmth, making patient feel valued?

### 4. Patient Engagement Signals (0-10)
- **Openness**: How much is the patient sharing? Personal stories = high openness.
- **Buying Signals**: Questions about scheduling, cost, financing = buying intent.
- **Resistance**: Deflecting, giving short answers, mentioning competitors = resistance.
- **Response Enthusiasm**: very_positive, positive, neutral, declining, negative

### 5. Red Flags & Opportunities
Identify specific moments that are concerning or promising.

### 6. Staff Coaching
Be specific and actionable. "You could have..." is better than "needs improvement."

### 7. HIPAA Compliance
Check if any PHI was shared inappropriately, if medical advice was given (should recommend consultation instead), or if sensitive data was transmitted over unsecured channels.

## Output
Respond ONLY with valid JSON matching the provided schema. Be specific — reference actual message content (by index) where possible.`

// ════════════════════════════════════════════════════════════════
// CORE FUNCTION
// ════════════════════════════════════════════════════════════════

/**
 * Analyze a complete conversation and store results.
 */
export async function analyzeConversation(
  supabase: SupabaseClient,
  config: {
    organization_id: string
    lead_id: string
    conversation_id: string
    lead: Record<string, unknown>
    messages: Array<{
      direction: string
      body: string
      sender_type: string
      created_at: string
    }>
  }
): Promise<ConversationAnalysis> {
  if (config.messages.length < 2) {
    throw new Error('Need at least 2 messages to analyze a conversation')
  }

  // HIPAA: Build safe history and detect PHI
  const safeHistory = buildSafeConversationHistory(config.messages)
  const safeLeadContext = buildSafeLeadContext(config.lead)

  // Also do our own PHI scan on the raw messages
  const phiFindings: Array<{ category: string; message_index: number; remediation: string }> = []
  config.messages.forEach((msg, idx) => {
    const phi = detectPHI(msg.body)
    for (const p of phi) {
      phiFindings.push({
        category: p.category,
        message_index: idx,
        remediation: `Message ${idx} contains ${p.category} data. ${msg.direction === 'outbound' ? 'Staff should avoid including PHI in messages.' : 'Patient shared PHI — handle securely.'}`,
      })
    }
  })

  // Log HIPAA event
  await logHIPAAEvent(supabase, {
    organization_id: config.organization_id,
    event_type: 'ai_processing',
    severity: 'info',
    actor_type: 'ai_agent',
    actor_id: 'conversation_analyst_agent',
    resource_type: 'conversation',
    resource_id: config.conversation_id,
    description: `Conversation analyst processing ${config.messages.length} messages (PHI-scrubbed)`,
  })

  // Calculate basic metrics
  const avgResponseTime = calculateAvgResponseTime(config.messages)
  const longestMessageBy = findLongestMessageAuthor(config.messages)

  const prompt = `Analyze this patient conversation.

## Patient Context
${safeLeadContext}

## Conversation (${config.messages.length} messages)
${safeHistory.map((m, i) => `[MSG ${i}] [${m.role === 'user' ? 'PATIENT' : 'STAFF'}] ${m.content}`).join('\n\n')}

## Pre-Detected PHI Issues
${phiFindings.length > 0 ? JSON.stringify(phiFindings) : 'None detected by automated scan.'}

## Metrics
- Total messages: ${config.messages.length}
- Average response time: ${avgResponseTime ? `${Math.round(avgResponseTime / 60)} minutes` : 'unknown'}
- Longest messages by: ${longestMessageBy}

## Required Output Schema
{
  "emotional_score": <0-10>,
  "engagement_score": <0-10>,
  "trust_score": <0-10>,
  "urgency_score": <0-10>,

  "patient_tone": "<warm|neutral|cold|anxious|excited|frustrated|defensive|hopeful|skeptical>",
  "staff_tone": "<professional|empathetic|pushy|cold|warm|aggressive|scripted|authentic>",
  "tone_alignment": "<matched|mismatched|improving|deteriorating>",

  "sales_pressure_level": <0-10>,
  "empathy_level": <0-10>,
  "active_listening_score": <0-10>,
  "objection_handling_quality": <0-10>,
  "rapport_building_score": <0-10>,

  "patient_openness": <0-10>,
  "patient_buying_signals": <0-10>,
  "patient_resistance": <0-10>,
  "response_enthusiasm": "<very_positive|positive|neutral|declining|negative>",

  "conversation_flow": "<natural|scripted|disjointed|flowing>",
  "turning_points": [{"message_index": <n>, "type": "positive_shift|negative_shift|breakthrough|setback", "description": "<what happened>"}],

  "red_flags": [{"flag": "<specific issue>", "severity": "low|medium|high|critical", "message_index": <n>}],
  "opportunities": [{"opportunity": "<what could be leveraged>", "type": "buying_signal|rapport|objection_opening|upsell", "message_index": <n>}],

  "coaching_notes": "<specific actionable feedback for the staff member>",
  "improvement_areas": ["<specific things to improve>"],
  "things_done_well": ["<specific things done well>"],

  "phi_detected": <true|false>,
  "phi_details": [{"category": "<type>", "message_index": <n>, "remediation": "<what to do>"}],
  "compliance_score": <0-100>,
  "compliance_issues": [{"issue": "<description>", "severity": "info|warning|violation|critical"}]
}`

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: CONVERSATION_ANALYST_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse conversation analysis response')

  const analysis: ConversationAnalysis = JSON.parse(jsonMatch[0])

  // Merge our PHI scan with AI's findings
  if (phiFindings.length > 0) {
    analysis.phi_detected = true
    analysis.phi_details = [...analysis.phi_details, ...phiFindings]
  }

  // Save to database
  const { error } = await supabase.from('conversation_analyses').upsert({
    organization_id: config.organization_id,
    conversation_id: config.conversation_id,
    lead_id: config.lead_id,
    ...analysis,
    message_count: config.messages.length,
    avg_response_time_seconds: avgResponseTime,
    longest_message_by: longestMessageBy,
    model_used: 'claude-sonnet-4-20250514',
    analyzed_at: new Date().toISOString(),
  }, {
    onConflict: 'conversation_id',
    ignoreDuplicates: false,
  })

  // The upsert might fail if there's no unique constraint on conversation_id
  // Fall back to insert
  if (error?.code === '42P10' || error?.message?.includes('unique')) {
    await supabase.from('conversation_analyses').insert({
      organization_id: config.organization_id,
      conversation_id: config.conversation_id,
      lead_id: config.lead_id,
      ...analysis,
      message_count: config.messages.length,
      avg_response_time_seconds: avgResponseTime,
      longest_message_by: longestMessageBy,
      model_used: 'claude-sonnet-4-20250514',
      analyzed_at: new Date().toISOString(),
    })
  }

  // Log compliance issues to HIPAA audit
  if (analysis.compliance_issues.length > 0) {
    const maxSeverity = analysis.compliance_issues.reduce((max, issue) => {
      const order = { info: 0, warning: 1, violation: 2, critical: 3 }
      const severityKey = issue.severity as keyof typeof order
      const maxKey = max as keyof typeof order
      return (order[severityKey] || 0) > (order[maxKey] || 0) ? issue.severity : max
    }, 'info')

    await logHIPAAEvent(supabase, {
      organization_id: config.organization_id,
      event_type: 'ai_phi_detected',
      severity: maxSeverity as 'info' | 'warning' | 'violation' | 'critical',
      actor_type: 'ai_agent',
      actor_id: 'conversation_analyst_agent',
      resource_type: 'conversation',
      resource_id: config.conversation_id,
      description: `Conversation analysis found ${analysis.compliance_issues.length} compliance issue(s)`,
      metadata: { issues: analysis.compliance_issues, score: analysis.compliance_score },
    })
  }

  // Log to ai_interactions
  await supabase.from('ai_interactions').insert({
    organization_id: config.organization_id,
    lead_id: config.lead_id,
    interaction_type: 'classification',
    model: 'claude-sonnet-4-20250514',
    prompt_tokens: response.usage?.input_tokens || 0,
    completion_tokens: response.usage?.output_tokens || 0,
    total_tokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
    output_summary: `Conversation analysis: engagement=${analysis.engagement_score}/10, trust=${analysis.trust_score}/10, pressure=${analysis.sales_pressure_level}/10`,
    success: true,
    metadata: {
      agent: 'conversation_analyst',
      conversation_id: config.conversation_id,
      message_count: config.messages.length,
    },
  })

  return analysis
}

// ════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ════════════════════════════════════════════════════════════════

function calculateAvgResponseTime(
  messages: Array<{ direction: string; created_at: string }>
): number | null {
  const responseTimes: number[] = []

  for (let i = 1; i < messages.length; i++) {
    if (messages[i].direction !== messages[i - 1].direction) {
      const prev = new Date(messages[i - 1].created_at).getTime()
      const curr = new Date(messages[i].created_at).getTime()
      responseTimes.push((curr - prev) / 1000)
    }
  }

  if (responseTimes.length === 0) return null
  return responseTimes.reduce((sum, t) => sum + t, 0) / responseTimes.length
}

function findLongestMessageAuthor(
  messages: Array<{ direction: string; body: string }>
): string {
  let patientMax = 0
  let staffMax = 0

  for (const msg of messages) {
    if (msg.direction === 'inbound' && msg.body.length > patientMax) {
      patientMax = msg.body.length
    } else if (msg.direction === 'outbound' && msg.body.length > staffMax) {
      staffMax = msg.body.length
    }
  }

  return patientMax > staffMax ? 'patient' : 'staff'
}

/**
 * Get all analyses for a lead across conversations.
 */
export async function getLeadAnalyses(
  supabase: SupabaseClient,
  leadId: string
): Promise<ConversationAnalysis[]> {
  const { data } = await supabase
    .from('conversation_analyses')
    .select('*')
    .eq('lead_id', leadId)
    .order('analyzed_at', { ascending: false })

  return (data || []) as unknown as ConversationAnalysis[]
}

/**
 * Get the most recent analysis for a conversation.
 */
export async function getConversationAnalysis(
  supabase: SupabaseClient,
  conversationId: string
): Promise<ConversationAnalysis | null> {
  const { data } = await supabase
    .from('conversation_analyses')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('analyzed_at', { ascending: false })
    .limit(1)
    .single()

  return data as unknown as ConversationAnalysis | null
}
