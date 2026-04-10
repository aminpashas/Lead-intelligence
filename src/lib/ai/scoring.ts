import Anthropic from '@anthropic-ai/sdk'
import type { Lead } from '@/types/database'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildSafeLeadContext, buildSafeConversationHistory, checkResponseCompliance, logHIPAAEvent, scrubPHI } from './hipaa'

function getAnthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
}

export type ScoreDimension = {
  name: string
  score: number // 0-100
  weight: number // 0-1, all weights sum to 1
  reasoning: string
}

export type ScoreResult = {
  total_score: number // 0-100
  qualification: 'hot' | 'warm' | 'cold' | 'unqualified'
  dimensions: ScoreDimension[]
  summary: string
  recommended_action: string
  confidence: number // 0-1
}

const SCORING_PROMPT = `You are an AI lead scoring engine for an All-on-4 dental implant practice CRM.
Your job is to evaluate dental implant leads and assign scores that predict conversion likelihood.

## Scoring Dimensions (weights sum to 1.0)

1. **Dental Condition Severity** (weight: 0.25)
   - Missing all teeth (upper/lower/both) = 80-100
   - Failing teeth / extensive decay = 60-80
   - Denture problems seeking permanent solution = 70-90
   - Missing multiple teeth = 40-60
   - Unknown/vague condition = 20-40
   - No clear need = 0-20

2. **Financial Readiness** (weight: 0.20)
   - Cash pay ready = 90-100
   - Financing pre-approved = 80-95
   - Has dental insurance + open to financing = 60-80
   - Interested in financing, no pre-approval = 40-60
   - Insurance only, no financing interest = 20-40
   - No financial info = 10-30

3. **Urgency & Timeline** (weight: 0.20)
   - Wants treatment ASAP / in pain = 85-100
   - Looking within 1-3 months = 60-85
   - Within 6 months = 40-60
   - Just researching / no timeline = 20-40
   - Indicated distant future = 0-20

4. **Engagement Level** (weight: 0.15)
   - Responded quickly, multiple interactions = 80-100
   - Responded to messages, some engagement = 50-80
   - Slow to respond, minimal engagement = 20-50
   - No response yet = 0-20

5. **Demographics & Fit** (weight: 0.10)
   - Matches ideal patient profile (age 45-75, local area) = 70-100
   - Partially matches = 40-70
   - Unknown demographics = 20-40
   - Poor fit (too young, too far) = 0-20

6. **Source Quality** (weight: 0.10)
   - Direct referral from existing patient = 90-100
   - Google Ads (high-intent keywords) = 70-90
   - Website organic form submission = 60-80
   - Meta/Facebook ads = 40-60
   - General marketing campaign = 20-40

## Qualification Thresholds
- Hot (75-100): Ready for immediate consultation scheduling
- Warm (50-74): Nurture with education, address objections
- Cold (25-49): Long-term drip campaign, needs significant nurturing
- Unqualified (0-24): Likely not a candidate, deprioritize

## Output Format
Respond ONLY with valid JSON matching this structure:
{
  "dimensions": [
    {"name": "dental_condition", "score": <0-100>, "weight": 0.25, "reasoning": "<brief reasoning>"},
    {"name": "financial_readiness", "score": <0-100>, "weight": 0.20, "reasoning": "<brief reasoning>"},
    {"name": "urgency", "score": <0-100>, "weight": 0.20, "reasoning": "<brief reasoning>"},
    {"name": "engagement", "score": <0-100>, "weight": 0.15, "reasoning": "<brief reasoning>"},
    {"name": "demographics", "score": <0-100>, "weight": 0.10, "reasoning": "<brief reasoning>"},
    {"name": "source_quality", "score": <0-100>, "weight": 0.10, "reasoning": "<brief reasoning>"}
  ],
  "summary": "<2-3 sentence lead summary for the practice team>",
  "recommended_action": "<specific next step recommendation>",
  "confidence": <0.0-1.0>
}`

function buildLeadContext(lead: Partial<Lead>): string {
  const parts: string[] = []

  parts.push(`Name: ${lead.first_name || 'Unknown'} ${lead.last_name || ''}`.trim())
  if (lead.email) parts.push(`Email: ${lead.email}`)
  if (lead.phone) parts.push(`Phone: ${lead.phone}`)
  if (lead.city && lead.state) parts.push(`Location: ${lead.city}, ${lead.state}`)
  if (lead.age) parts.push(`Age: ${lead.age}`)

  // Dental info
  if (lead.dental_condition) parts.push(`Dental Condition: ${lead.dental_condition.replace(/_/g, ' ')}`)
  if (lead.dental_condition_details) parts.push(`Condition Details: ${lead.dental_condition_details}`)
  if (lead.current_dental_situation) parts.push(`Current Situation: ${lead.current_dental_situation}`)
  if (lead.has_dentures !== null && lead.has_dentures !== undefined) parts.push(`Has Dentures: ${lead.has_dentures ? 'Yes' : 'No'}`)

  // Financial
  if (lead.financing_interest) parts.push(`Financing Interest: ${lead.financing_interest.replace(/_/g, ' ')}`)
  if (lead.budget_range) parts.push(`Budget Range: ${lead.budget_range.replace(/_/g, ' ')}`)
  if (lead.has_dental_insurance !== null && lead.has_dental_insurance !== undefined) parts.push(`Dental Insurance: ${lead.has_dental_insurance ? 'Yes' : 'No'}`)
  if (lead.insurance_provider) parts.push(`Insurance Provider: ${lead.insurance_provider}`)

  // Engagement
  if (lead.total_messages_received) parts.push(`Messages Received from Lead: ${lead.total_messages_received}`)
  if (lead.total_messages_sent) parts.push(`Messages Sent to Lead: ${lead.total_messages_sent}`)
  if (lead.last_responded_at) parts.push(`Last Response: ${lead.last_responded_at}`)
  if (lead.response_time_avg_minutes) parts.push(`Avg Response Time: ${lead.response_time_avg_minutes} minutes`)

  // Source
  if (lead.source_type) parts.push(`Lead Source: ${lead.source_type.replace(/_/g, ' ')}`)
  if (lead.utm_source) parts.push(`UTM Source: ${lead.utm_source}`)
  if (lead.utm_campaign) parts.push(`UTM Campaign: ${lead.utm_campaign}`)

  // Status
  parts.push(`Current Status: ${lead.status || 'new'}`)
  if (lead.no_show_count && lead.no_show_count > 0) parts.push(`No-Show Count: ${lead.no_show_count}`)
  if (lead.notes) parts.push(`Notes: ${lead.notes}`)

  return parts.join('\n')
}

export async function scoreLead(
  lead: Partial<Lead>,
  supabase?: SupabaseClient
): Promise<ScoreResult> {
  // Use HIPAA-safe context — no email, phone, full name, or address sent to AI
  const leadContext = buildSafeLeadContext(lead as Record<string, unknown>)

  // Log AI access if supabase client available
  if (supabase && lead.organization_id && lead.id) {
    await logHIPAAEvent(supabase, {
      organization_id: lead.organization_id,
      event_type: 'ai_scoring',
      severity: 'info',
      actor_type: 'ai_agent',
      actor_id: 'lead_scorer',
      resource_type: 'lead',
      resource_id: lead.id,
      description: 'AI lead scoring initiated with HIPAA-safe context',
    })
  }

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `Score this dental implant lead:\n\n${leadContext}`,
      },
    ],
    system: SCORING_PROMPT,
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error('Failed to parse AI scoring response')
  }

  const parsed = JSON.parse(jsonMatch[0])

  // Calculate weighted total score
  const totalScore = Math.round(
    parsed.dimensions.reduce(
      (sum: number, d: { score: number; weight: number }) => sum + d.score * d.weight,
      0
    )
  )

  // Determine qualification tier
  let qualification: ScoreResult['qualification']
  if (totalScore >= 75) qualification = 'hot'
  else if (totalScore >= 50) qualification = 'warm'
  else if (totalScore >= 25) qualification = 'cold'
  else qualification = 'unqualified'

  return {
    total_score: totalScore,
    qualification,
    dimensions: parsed.dimensions,
    summary: parsed.summary,
    recommended_action: parsed.recommended_action,
    confidence: parsed.confidence,
  }
}

export async function generateLeadEngagement(
  lead: Partial<Lead>,
  conversationHistory: Array<{ role: string; content: string }>,
  context: {
    mode: 'education' | 'objection_handling' | 'appointment_scheduling' | 'follow_up'
    channel: 'sms' | 'email'
  },
  supabase?: SupabaseClient
): Promise<{ message: string; confidence: number }> {
  // Use HIPAA-safe context — no direct identifiers sent to AI
  const leadContext = buildSafeLeadContext(lead as Record<string, unknown>)

  // Scrub PHI from conversation history before sending to AI
  const safeHistory = conversationHistory.map((msg) => ({
    role: msg.role as 'user' | 'assistant',
    content: scrubPHI(msg.content),
  }))

  const systemPrompt = `You are an AI assistant for a dental implant practice specializing in All-on-4 full arch implants.
You are communicating with a potential patient via ${context.channel === 'sms' ? 'text message (keep messages under 160 chars when possible)' : 'email'}.

Your goal: ${
    context.mode === 'education'
      ? 'Educate the lead about All-on-4 dental implants, address misconceptions, and build confidence in the procedure.'
      : context.mode === 'objection_handling'
        ? 'Address the lead\'s concerns (cost, pain, recovery time, etc.) with empathy and factual information.'
        : context.mode === 'appointment_scheduling'
          ? 'Guide the lead toward scheduling a free consultation. Be helpful, not pushy.'
          : 'Follow up warmly, check on their decision process, and offer to answer questions.'
  }

Lead Profile:
${leadContext}

Guidelines:
- Be warm, professional, and empathetic
- Use simple language, avoid medical jargon
- Never make specific medical claims or diagnoses
- Always recommend an in-person consultation for specific treatment advice
- For SMS: Keep messages concise and conversational
- For email: Use a professional but friendly tone
- If the lead seems disqualified or uninterested, gracefully disengage
- Never pressure or use aggressive sales tactics
- HIPAA: Never include patient identifiers (full name, phone, email, SSN, DOB) in your response
- HIPAA: Never ask patients to share sensitive information via text/email`

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: context.channel === 'sms' ? 256 : 1024,
    system: systemPrompt,
    messages: safeHistory,
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''

  // Check response for HIPAA compliance before returning
  const complianceIssues = checkResponseCompliance(text)
  const hasCriticalIssue = complianceIssues.some(
    (i) => i.severity === 'critical' || i.severity === 'violation'
  )

  // Log compliance issues if supabase available
  if (supabase && lead.organization_id && complianceIssues.length > 0) {
    await logHIPAAEvent(supabase, {
      organization_id: lead.organization_id,
      event_type: hasCriticalIssue ? 'ai_compliance_violation' : 'ai_compliance_warning',
      severity: hasCriticalIssue ? 'warning' : 'info',
      actor_type: 'ai_agent',
      actor_id: 'engagement_generator',
      resource_type: 'lead',
      resource_id: lead.id,
      description: `AI response compliance: ${complianceIssues.map((i) => i.category).join(', ')}`,
      metadata: { issues: complianceIssues, channel: context.channel },
    })
  }

  // If critical compliance issue, scrub the response before returning
  const finalMessage = hasCriticalIssue ? scrubPHI(text) : text

  return {
    message: finalMessage,
    confidence: hasCriticalIssue ? 0.5 : 0.85,
  }
}
