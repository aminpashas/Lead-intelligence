import Anthropic from '@anthropic-ai/sdk'
import type { Lead } from '@/types/database'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildSafeLeadContext, buildSafeConversationHistory, checkResponseCompliance, logHIPAAEvent, scrubPHI } from './hipaa'
import { getEnrichmentSummary } from '@/lib/enrichment'
import type { EnrichmentSummary } from '@/lib/enrichment/types'
import type { PatientProfile } from '@/types/database'
import { formatPatientPsychologyForPrompt } from './agent-types'
import { analyzeTextingStyle, formatTextingStyleBlock } from './texting-style'
import { buildBrandIdentityBlock } from '@/lib/branding/prompt-block'
import { createServiceClient } from '@/lib/supabase/server'

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

1. **Dental Condition Severity** (weight: 0.22)
   - Missing all teeth (upper/lower/both) = 80-100
   - Failing teeth / extensive decay = 60-80
   - Denture problems seeking permanent solution = 70-90
   - Missing multiple teeth = 40-60
   - Unknown/vague condition = 20-40
   - No clear need = 0-20

2. **Financial Readiness** (weight: 0.18)
   - Cash pay ready = 90-100
   - Financing pre-approved = 80-95
   - Has dental insurance + open to financing = 60-80
   - Interested in financing, no pre-approval = 40-60
   - Insurance only, no financing interest = 20-40
   - No financial info = 10-30
   Adjust for self-reported credit when present: excellent/good credit → toward the
   top of the applicable band (financing approval is likely); fair → middle; rebuilding
   → lower the band (approval is harder — but in-house/no-credit-check plans still exist,
   so do NOT zero it out). Credit is a modifier, not the whole dimension.

3. **Urgency & Timeline** (weight: 0.18)
   - Wants treatment ASAP / in pain = 85-100
   - Looking within 1-3 months = 60-85
   - Within 6 months = 40-60
   - Just researching / no timeline = 20-40
   - Indicated distant future = 0-20

4. **Engagement Level** (weight: 0.12)
   - Responded quickly, multiple interactions = 80-100
   - Responded to messages, some engagement = 50-80
   - Slow to respond, minimal engagement = 20-50
   - No response yet = 0-20

5. **Demographics & Fit** (weight: 0.08)
   - Matches ideal patient profile (age 45-75, local area) = 70-100
   - Partially matches = 40-70
   - Unknown demographics = 20-40
   - Poor fit (too young, too far) = 0-20

6. **Source Quality** (weight: 0.07)
   - Direct referral from existing patient = 90-100
   - Google Ads (high-intent keywords) = 70-90
   - Website organic form submission = 60-80
   - Meta/Facebook ads = 40-60
   - General marketing campaign = 20-40

7. **Identity Confidence** (weight: 0.08)
   Based on enrichment/verification data. Score 30 (neutral) if no data available.
   - Valid email + valid mobile phone + IP matches area = 90-100
   - Valid email + valid phone (any type) = 70-90
   - Valid email OR valid phone, not both verified = 40-70
   - Email disposable or invalid = 10-30
   - No verification data available = 30

8. **Behavioral Intent Signals** (weight: 0.07)
   Based on website behavior and search keywords. Score 30 (neutral) if no data available.
   - High-intent search keyword + pricing page viewed + financing page = 85-100
   - Pricing page viewed + extended time on site (>2 min) = 60-85
   - Multiple sessions + some browsing = 40-60
   - Minimal site engagement = 10-30
   - No behavioral data available = 30

## Qualification Thresholds
- Hot (75-100): Ready for immediate consultation scheduling
- Warm (50-74): Nurture with education, address objections
- Cold (25-49): Long-term drip campaign, needs significant nurturing
- Unqualified (0-24): Likely not a candidate, deprioritize

## Output Format
Respond ONLY with valid JSON matching this structure:
{
  "dimensions": [
    {"name": "dental_condition", "score": <0-100>, "weight": 0.22, "reasoning": "<brief reasoning>"},
    {"name": "financial_readiness", "score": <0-100>, "weight": 0.18, "reasoning": "<brief reasoning>"},
    {"name": "urgency", "score": <0-100>, "weight": 0.18, "reasoning": "<brief reasoning>"},
    {"name": "engagement", "score": <0-100>, "weight": 0.12, "reasoning": "<brief reasoning>"},
    {"name": "demographics", "score": <0-100>, "weight": 0.08, "reasoning": "<brief reasoning>"},
    {"name": "source_quality", "score": <0-100>, "weight": 0.07, "reasoning": "<brief reasoning>"},
    {"name": "identity_confidence", "score": <0-100>, "weight": 0.08, "reasoning": "<brief reasoning>"},
    {"name": "behavioral_intent", "score": <0-100>, "weight": 0.07, "reasoning": "<brief reasoning>"}
  ],
  "summary": "<2-3 sentence lead summary for the practice team>",
  "recommended_action": "<specific next step recommendation>",
  "confidence": <0.0-1.0>
}`

export type TreatmentVertical = 'implant' | 'tmj' | 'sleep_apnea'

/**
 * Campaign-vertical detection: ad webhooks tag non-implant leads (TMJ, sleep
 * apnea) at ingestion so scoring/outreach don't treat them as implant leads.
 */
export function getTreatmentVertical(lead: Partial<Lead>): TreatmentVertical {
  const fromCustom = lead.custom_fields?.treatment_interest
  if (fromCustom === 'tmj' || fromCustom === 'sleep_apnea') return fromCustom
  if (Array.isArray(lead.tags)) {
    if (lead.tags.includes('tmj')) return 'tmj'
    if (lead.tags.includes('sleep_apnea')) return 'sleep_apnea'
  }
  return 'implant'
}

const VERTICAL_ADDENDA: Record<Exclude<TreatmentVertical, 'implant'>, string> = {
  tmj: `

## Treatment Vertical Override — TMJ
This lead came from a TMJ (temporomandibular joint disorder) treatment campaign, NOT an implant campaign. Do not evaluate them as an implant candidate.
- Reinterpret dimension 1 (keep the JSON name "dental_condition") as TMJ condition severity: chronic jaw pain / locking / clicking with daily-life impact = 80-100; frequent jaw-attributed headaches or migraines = 60-80; intermittent clicking or discomfort = 40-60; vague or unknown symptoms = 20-40.
- Reinterpret financial_readiness against a TMJ treatment price point (a fraction of full-arch implant cost; medical insurance sometimes contributes). Do NOT penalize the lead for lacking implant-level budget.
- All other dimensions, weights, JSON dimension names, and the output format are unchanged.`,
  sleep_apnea: `

## Treatment Vertical Override — Sleep Apnea
This lead came from a sleep apnea treatment campaign, NOT an implant campaign. Do not evaluate them as an implant candidate.
- Reinterpret dimension 1 (keep the JSON name "dental_condition") as sleep apnea severity/readiness: diagnosed OSA with CPAP intolerance seeking an oral appliance = 80-100; sleep study completed but untreated = 60-80; loud snoring / partner complaints without a diagnosis = 40-60; vague or unknown symptoms = 20-40.
- Reinterpret financial_readiness against oral appliance therapy pricing (medical insurance frequently covers part of it). Do NOT penalize the lead for lacking implant-level budget.
- All other dimensions, weights, JSON dimension names, and the output format are unchanged.`,
}

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
  if (lead.credit_range && lead.credit_range !== 'unknown') parts.push(`Self-Reported Credit: ${lead.credit_range}`)
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

/**
 * Build enrichment context for AI scoring.
 * Contains NO PHI — only aggregated boolean/categorical signals.
 */
function buildEnrichmentContext(enrichment: EnrichmentSummary): string {
  const parts: string[] = ['\n--- Enrichment Data (Verified Signals) ---']

  if (enrichment.email_valid !== null) {
    parts.push(`Email Verified: ${enrichment.email_valid ? 'Yes' : 'No'}`)
    if (enrichment.email_disposable) parts.push('Email Type: Disposable/temporary')
    if (enrichment.email_free) parts.push('Email Provider: Free (Gmail, Yahoo, etc.)')
  }

  if (enrichment.phone_valid !== null) {
    parts.push(`Phone Verified: ${enrichment.phone_valid ? 'Yes' : 'No'}`)
    if (enrichment.phone_line_type) parts.push(`Phone Type: ${enrichment.phone_line_type}`)
  }

  if (enrichment.ip_location_match !== null) {
    parts.push(`Location Match (IP vs Practice): ${enrichment.ip_location_match ? 'Yes (within 100 miles)' : 'No (distant)'}`)
  }
  if (enrichment.distance_to_practice_miles !== null) {
    parts.push(`Distance to Practice: ${enrichment.distance_to_practice_miles} miles`)
  }
  if (enrichment.ip_is_proxy) {
    parts.push('Connection: Proxy/VPN detected (may indicate privacy concern or fraud)')
  }

  if (enrichment.search_keyword) {
    parts.push(`Search Keyword: "${enrichment.search_keyword}"`)
  }

  if (enrichment.pricing_page_viewed !== null) {
    parts.push(`Viewed Pricing Page: ${enrichment.pricing_page_viewed ? 'Yes' : 'No'}`)
  }
  if (enrichment.financing_page_viewed) {
    parts.push('Viewed Financing Page: Yes')
  }
  if (enrichment.time_on_site_seconds && enrichment.time_on_site_seconds > 0) {
    parts.push(`Time on Site: ${Math.round(enrichment.time_on_site_seconds / 60)} minutes`)
  }
  if (enrichment.session_count && enrichment.session_count > 1) {
    parts.push(`Return Visits: ${enrichment.session_count} sessions`)
  }

  parts.push(`Identity Confidence Score: ${enrichment.identity_confidence}/100`)
  parts.push(`Enrichment Score: ${enrichment.enrichment_score}/100`)

  return parts.join('\n')
}

export async function scoreLead(
  lead: Partial<Lead>,
  supabase?: SupabaseClient
): Promise<ScoreResult> {
  // Use HIPAA-safe context — no email, phone, full name, or address sent to AI
  let leadContext = buildSafeLeadContext(lead as Record<string, unknown>)

  // Fetch enrichment data if available (no PHI — only aggregated signals)
  let enrichment: EnrichmentSummary | null = null
  if (supabase && lead.id) {
    enrichment = await getEnrichmentSummary(supabase, lead.id)
  }
  if (enrichment) {
    leadContext += '\n' + buildEnrichmentContext(enrichment)
  }

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

  const vertical = getTreatmentVertical(lead)
  const verticalLabel =
    vertical === 'tmj' ? 'TMJ treatment' : vertical === 'sleep_apnea' ? 'sleep apnea treatment' : 'dental implant'
  const systemPrompt =
    vertical === 'implant' ? SCORING_PROMPT : SCORING_PROMPT + VERTICAL_ADDENDA[vertical]

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `Score this ${verticalLabel} lead:\n\n${leadContext}`,
      },
    ],
    system: systemPrompt,
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

/**
 * Score a lead AND persist the result: writes ai_score/ai_qualification/breakdown
 * onto the lead, logs a `score_updated` activity, and records the AI interaction.
 *
 * Single source of truth for "re-grade this lead" — used by the manual
 * POST /api/leads/[id]/score route AND automatically by the setter after a
 * conversation captures new qualification data (goal, credit, timeline).
 */
export async function rescoreAndPersistLead(
  supabase: SupabaseClient,
  lead: Partial<Lead>
): Promise<ScoreResult> {
  if (!lead.id || !lead.organization_id) {
    throw new Error('rescoreAndPersistLead requires lead.id and lead.organization_id')
  }

  // Reads (enrichment + HIPAA audit) use the caller's client. The PERSIST does
  // not: scoring runs from agency-admin (cross-org), setter, and cron paths
  // whose ambient RLS context — `organization_id = get_user_org_id()` — often
  // won't resolve to the lead's org. An RLS-gated `.update().eq('id', …)` then
  // matches 0 rows and *silently* no-ops (Supabase returns no error for a 0-row
  // update), so a lead that logged "AI Score: N" in history reads as Unscored.
  // Persist via a service-role client keyed on organization_id, then verify a
  // row came back so a genuinely failed write throws instead of vanishing.
  const scoreResult = await scoreLead(lead, supabase)

  const db = createServiceClient()

  const { data: updated, error: updateError } = await db
    .from('leads')
    .update({
      ai_score: scoreResult.total_score,
      ai_qualification: scoreResult.qualification,
      ai_score_breakdown: {
        dimensions: scoreResult.dimensions,
        confidence: scoreResult.confidence,
      },
      ai_score_updated_at: new Date().toISOString(),
      ai_summary: scoreResult.summary,
    })
    .eq('id', lead.id)
    .eq('organization_id', lead.organization_id)
    .select('id')
    .maybeSingle()

  if (updateError) {
    throw new Error(`Failed to persist lead score: ${updateError.message}`)
  }
  if (!updated) {
    throw new Error(
      `Lead score computed but not persisted: no leads row matched id=${lead.id} org=${lead.organization_id}`
    )
  }

  await db.from('lead_activities').insert({
    organization_id: lead.organization_id,
    lead_id: lead.id,
    activity_type: 'score_updated',
    title: `AI Score: ${scoreResult.total_score}/100 (${scoreResult.qualification})`,
    description: scoreResult.summary,
    metadata: scoreResult,
  })

  await db.from('ai_interactions').insert({
    organization_id: lead.organization_id,
    lead_id: lead.id,
    interaction_type: 'scoring',
    model: 'claude-sonnet-4-6',
    output_summary: `Score: ${scoreResult.total_score}, Qualification: ${scoreResult.qualification}`,
    success: true,
  })

  return scoreResult
}

export async function generateLeadEngagement(
  lead: Partial<Lead>,
  conversationHistory: Array<{ role: string; content: string }>,
  context: {
    mode: 'education' | 'objection_handling' | 'appointment_scheduling' | 'follow_up'
    channel: 'sms' | 'email'
    /**
     * The analyzer's persisted read of this patient (the same row that powers
     * the Lead Intelligence panel). When present, its narrative summary,
     * next-best-action, and angry-lead tone override are woven into the prompt
     * so even this fallback drafter can't produce a message that ignores what
     * staff already see beside the composer.
     */
    patientProfile?: PatientProfile | null
  },
  supabase?: SupabaseClient
): Promise<{ message: string; confidence: number }> {
  // Use HIPAA-safe context — no direct identifiers sent to AI
  const leadContext = buildSafeLeadContext(lead as Record<string, unknown>)

  // Ground the fallback in the same patient psychology the primary agents use.
  // Without this, a fragile primary call degrades into a summary-blind, canned
  // reply that reads as tone-deaf on an upset or mid-negotiation lead.
  const psychologyBlock = context.patientProfile
    ? `\n\nPatient Psychology (read this and act on it — do NOT ignore it):\n${formatPatientPsychologyForPrompt(context.patientProfile)}`
    : ''

  // Mirror how THIS patient actually texts — the same block the live inbound
  // setter/closer agents use. Without it, the outbound drafter answers a quiet,
  // two-word lead with a four-line paragraph: the #1 tell that a bot is texting.
  // For first-touch (no inbound yet) the block tells it to open short and low-
  // pressure. SMS only — the length rules are written for texting cadence.
  const styleBlock =
    context.channel === 'sms'
      ? `\n\n${formatTextingStyleBlock(
          analyzeTextingStyle(
            conversationHistory.filter((m) => m.role === 'user').map((m) => m.content)
          )
        )}`
      : ''

  // Scrub PHI from conversation history before sending to AI
  const safeHistory = conversationHistory.map((msg) => ({
    role: msg.role as 'user' | 'assistant',
    content: scrubPHI(msg.content),
  }))

  // Pin the per-service-line DBA so even this fallback can't sign an implant
  // email with the TMJ center's name (implant leads → the implants brand;
  // TMJ/sleep brand only on explicit lead signal).
  const brandBlock =
    supabase && lead.organization_id
      ? await buildBrandIdentityBlock(supabase, lead.organization_id, {
          lead,
          fallbackServiceLine: 'implants',
        })
      : ''

  const systemPrompt = `You are a real person on the team at a dental implant practice specializing in All-on-4 full arch implants, ${context.channel === 'sms' ? 'texting' : 'emailing'} a patient who reached out to us. You are NOT a chatbot and must never sound like one.

Your goal: ${
    context.mode === 'education'
      ? "Answer what THIS patient is actually weighing (see their profile) about All-on-4 — clear up the one misconception most relevant to them. Don't dump generic facts."
      : context.mode === 'objection_handling'
        ? "Address the specific concern this patient has shown (cost, pain, recovery, credit, timing — see their profile) with empathy and one concrete, honest point. Don't recite a list."
        : context.mode === 'appointment_scheduling'
          ? 'Get them to a free consultation. Make it easy — offer a concrete next step and ask ONE simple scheduling question.'
          : "Nudge them forward based on where THEY left off (see their profile and history). Check in like a person who remembers them, not a mass blast."
  }

Lead Profile:
${leadContext}${psychologyBlock}${styleBlock}

${brandBlock ? `${brandBlock}\n\n` : ''}Write it like a human who knows this patient:
- OPEN ON THEM, NOT ON YOU. Reference the specific thing in their profile — their situation, timeline, financing signal, or what they asked about. A message that could have been sent to any of 10,000 leads has failed.
- One idea, one ask. End with a single, easy, specific question — not "let us know if you have any questions."
- Sound like a text from a helpful human. Contractions, plain words, natural rhythm. ${context.channel === 'sms' ? 'Under 160 chars when you can.' : 'Short paragraphs, no corporate letterhead tone.'}

NEVER write these bot-tells (instant rewrite if you catch yourself):
- "I hope this message finds you well" / "I wanted to reach out" / "Just following up"
- "We specialize in..." / "Our team is dedicated to..." / "At [practice], we..."
- "Feel free to reach out" / "Don't hesitate to contact us" / "We're here for you"
- Stacking multiple questions, or listing 3+ facts in one message.

Guardrails (never break):
- No specific medical claims or diagnoses; recommend an in-person consult for treatment specifics.
- Never pressure or use aggressive sales tactics. If the lead is disqualified or uninterested, disengage gracefully.
- HIPAA: Never include patient identifiers (full name, phone, email, SSN, DOB) in your response.
- HIPAA: Never ask patients to share sensitive information via text/email.`

  // The Anthropic Messages API rejects an empty `messages` array with a 400.
  // First-touch outreach (compose dialog, campaign send) has no prior messages,
  // so seed an operator instruction: the model writes the opening message from
  // the system prompt's goal + lead profile above.
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> =
    safeHistory.length > 0
      ? safeHistory
      : [
          {
            role: 'user',
            content: `Write the opening ${context.channel === 'sms' ? 'text message' : 'email'} to send to this lead now. Open on something specific from their profile above (not a generic greeting), keep it to one idea, and end with one easy question. Reply with only the message content — no preamble.`,
          },
        ]

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: context.channel === 'sms' ? 256 : 1024,
    system: systemPrompt,
    messages,
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
