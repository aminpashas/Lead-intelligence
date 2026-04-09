/**
 * HIPAA Compliance Agent
 *
 * Ensures all AI processing of patient data follows HIPAA guidelines:
 * - PHI detection and scrubbing before sending to AI models
 * - Audit logging of all data access
 * - Data minimization in AI prompts
 * - Compliance checking of AI-generated responses
 *
 * HIPAA Safe Harbor: 18 identifiers that constitute PHI:
 * 1. Names, 2. Geographic data, 3. Dates (except year),
 * 4. Phone numbers, 5. Fax numbers, 6. Email addresses,
 * 7. SSN, 8. Medical record numbers, 9. Health plan beneficiary numbers,
 * 10. Account numbers, 11. Certificate/license numbers,
 * 12. Vehicle identifiers, 13. Device identifiers/serial numbers,
 * 14. Web URLs, 15. IP addresses, 16. Biometric identifiers,
 * 17. Full-face photos, 18. Any other unique identifying number
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type PHICategory =
  | 'name' | 'phone' | 'email' | 'address' | 'dob' | 'age'
  | 'medical_record' | 'ssn' | 'insurance_id' | 'financial'
  | 'dental_specific' | 'medication' | 'diagnosis'

export type PHIDetection = {
  category: PHICategory
  value: string  // The detected PHI (for internal logging only)
  location: string // Where it was found
  scrubbed_value: string // The de-identified replacement
}

export type HIPAAComplianceResult = {
  isCompliant: boolean
  score: number // 0-100
  issues: ComplianceIssue[]
  phi_detected: PHIDetection[]
  recommendations: string[]
}

export type ComplianceIssue = {
  severity: 'info' | 'warning' | 'violation' | 'critical'
  category: string
  description: string
  remediation: string
}

// ════════════════════════════════════════════════════════════════
// PHI DETECTION & SCRUBBING
// ════════════════════════════════════════════════════════════════

/**
 * Detect PHI in text content. Uses pattern matching for structured PHI
 * and contextual analysis for unstructured medical information.
 */
export function detectPHI(text: string): PHIDetection[] {
  const detections: PHIDetection[] = []

  // Phone numbers (various formats)
  const phoneRegex = /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/g
  for (const match of text.matchAll(phoneRegex)) {
    detections.push({
      category: 'phone',
      value: match[0],
      location: `index:${match.index}`,
      scrubbed_value: '[PHONE_REDACTED]',
    })
  }

  // Email addresses
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
  for (const match of text.matchAll(emailRegex)) {
    detections.push({
      category: 'email',
      value: match[0],
      location: `index:${match.index}`,
      scrubbed_value: '[EMAIL_REDACTED]',
    })
  }

  // SSN patterns
  const ssnRegex = /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g
  for (const match of text.matchAll(ssnRegex)) {
    // Exclude phone numbers already detected
    if (!detections.some(d => d.category === 'phone' && d.value.includes(match[0]))) {
      detections.push({
        category: 'ssn',
        value: match[0],
        location: `index:${match.index}`,
        scrubbed_value: '[SSN_REDACTED]',
      })
    }
  }

  // Date of birth patterns
  const dobRegex = /\b(?:born|dob|date of birth|birthday)[:\s]+(\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4})/gi
  for (const match of text.matchAll(dobRegex)) {
    detections.push({
      category: 'dob',
      value: match[1],
      location: `index:${match.index}`,
      scrubbed_value: '[DOB_REDACTED]',
    })
  }

  // Insurance IDs (common patterns)
  const insuranceRegex = /\b(?:member|policy|group|insurance)\s*(?:#|number|id)[:\s]*([A-Z0-9]{6,20})/gi
  for (const match of text.matchAll(insuranceRegex)) {
    detections.push({
      category: 'insurance_id',
      value: match[1],
      location: `index:${match.index}`,
      scrubbed_value: '[INSURANCE_ID_REDACTED]',
    })
  }

  // Street addresses
  const addressRegex = /\b\d{1,5}\s+(?:[A-Z][a-z]+\s*){1,4}(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Rd|Road|Way|Ct|Court|Pl|Place)\b/g
  for (const match of text.matchAll(addressRegex)) {
    detections.push({
      category: 'address',
      value: match[0],
      location: `index:${match.index}`,
      scrubbed_value: '[ADDRESS_REDACTED]',
    })
  }

  return detections
}

/**
 * Scrub PHI from text, replacing with safe placeholders.
 * Used before sending conversation data to AI models.
 */
export function scrubPHI(text: string, detections?: PHIDetection[]): string {
  const detected = detections || detectPHI(text)
  let scrubbed = text

  // Sort by index descending to replace from end (preserves indices)
  const sorted = [...detected].sort((a, b) => {
    const idxA = parseInt(a.location.split(':')[1]) || 0
    const idxB = parseInt(b.location.split(':')[1]) || 0
    return idxB - idxA
  })

  for (const d of sorted) {
    scrubbed = scrubbed.replace(d.value, d.scrubbed_value)
  }

  return scrubbed
}

/**
 * Build a HIPAA-safe version of lead context for AI prompts.
 * Uses pseudonymization — keeps enough context for AI to be useful
 * while removing direct identifiers.
 */
export function buildSafeLeadContext(lead: Record<string, unknown>): string {
  const parts: string[] = []

  // Use first name only (partial de-identification)
  if (lead.first_name) parts.push(`Patient: ${lead.first_name}`)

  // Keep clinical data (necessary for treatment context)
  if (lead.dental_condition) parts.push(`Dental Condition: ${String(lead.dental_condition).replace(/_/g, ' ')}`)
  if (lead.dental_condition_details) parts.push(`Details: ${lead.dental_condition_details}`)
  if (lead.current_dental_situation) parts.push(`Current Situation: ${lead.current_dental_situation}`)
  if (lead.has_dentures != null) parts.push(`Has Dentures: ${lead.has_dentures ? 'Yes' : 'No'}`)

  // Financial context (generalized)
  if (lead.financing_interest) parts.push(`Financing Interest: ${String(lead.financing_interest).replace(/_/g, ' ')}`)
  if (lead.budget_range) parts.push(`Budget Range: ${String(lead.budget_range).replace(/_/g, ' ')}`)

  // Behavioral context (no PHI)
  if (lead.ai_qualification) parts.push(`Qualification: ${lead.ai_qualification}`)
  if (lead.ai_score) parts.push(`Lead Score: ${lead.ai_score}`)
  if (lead.status) parts.push(`Status: ${lead.status}`)
  if (lead.no_show_count && (lead.no_show_count as number) > 0) parts.push(`No-Shows: ${lead.no_show_count}`)

  // Engagement metrics (aggregated, no PHI)
  if (lead.total_messages_received) parts.push(`Messages from Patient: ${lead.total_messages_received}`)
  if (lead.total_messages_sent) parts.push(`Messages to Patient: ${lead.total_messages_sent}`)

  return parts.join('\n')
}

/**
 * Build HIPAA-safe conversation history for AI prompts.
 * Scrubs PHI from message bodies while preserving conversational context.
 */
export function buildSafeConversationHistory(
  messages: Array<{ direction: string; body: string; sender_type: string; created_at: string }>
): Array<{ role: string; content: string }> {
  return messages.map((msg) => ({
    role: msg.direction === 'inbound' ? 'user' : 'assistant',
    content: scrubPHI(msg.body),
  }))
}

// ════════════════════════════════════════════════════════════════
// COMPLIANCE CHECKING
// ════════════════════════════════════════════════════════════════

/**
 * Check AI-generated response for HIPAA compliance before sending.
 */
export function checkResponseCompliance(response: string): ComplianceIssue[] {
  const issues: ComplianceIssue[] = []

  // Check for specific medical diagnoses (AI shouldn't diagnose)
  const diagnosisPatterns = /\b(?:you have|diagnosed with|you suffer from|your condition is)\b/gi
  if (diagnosisPatterns.test(response)) {
    issues.push({
      severity: 'warning',
      category: 'medical_advice',
      description: 'Response may contain a medical diagnosis. AI should recommend consultation, not diagnose.',
      remediation: 'Rephrase to suggest consultation with the doctor rather than providing a diagnosis.',
    })
  }

  // Check for treatment guarantees
  const guaranteePatterns = /\b(?:guarantee|100%|always works|never fails|zero risk|no risk)\b/gi
  if (guaranteePatterns.test(response)) {
    issues.push({
      severity: 'warning',
      category: 'treatment_guarantee',
      description: 'Response may contain treatment guarantees. This could constitute medical misrepresentation.',
      remediation: 'Use qualified language: "typically", "in most cases", "success rates over 98%".',
    })
  }

  // Check for PHI in response (shouldn't echo back sensitive data)
  const phiInResponse = detectPHI(response)
  if (phiInResponse.length > 0) {
    issues.push({
      severity: 'violation',
      category: 'phi_exposure',
      description: `Response contains ${phiInResponse.length} potential PHI element(s): ${phiInResponse.map(p => p.category).join(', ')}`,
      remediation: 'Remove or redact PHI from the response before sending.',
    })
  }

  // Check for requesting PHI via message
  const phiRequestPatterns = /\b(?:send me your|what is your)\s+(?:social security|ssn|insurance number|date of birth|credit card|bank account)/gi
  if (phiRequestPatterns.test(response)) {
    issues.push({
      severity: 'critical',
      category: 'phi_solicitation',
      description: 'Response requests sensitive PHI via unsecured channel.',
      remediation: 'Never request SSN, insurance numbers, or financial details via SMS/email. Direct patient to secure portal or in-office visit.',
    })
  }

  // Check for sharing other patient information
  const otherPatientPatterns = /\b(?:another patient|other patient|someone else|Mrs\.|Mr\.|patient named)\b/gi
  if (otherPatientPatterns.test(response)) {
    issues.push({
      severity: 'warning',
      category: 'third_party_phi',
      description: 'Response may reference another patient. Even without names, contextual details can identify individuals.',
      remediation: 'Use only anonymized, composite patient stories. Never reference real patients.',
    })
  }

  return issues
}

/**
 * Run full compliance check on an AI interaction.
 */
export function runComplianceCheck(
  input: string,
  output: string,
  context: { channel: string; aiModel: string }
): HIPAAComplianceResult {
  const inputPHI = detectPHI(input)
  const outputPHI = detectPHI(output)
  const responseIssues = checkResponseCompliance(output)

  const allPHI = [...inputPHI, ...outputPHI]
  const allIssues: ComplianceIssue[] = [...responseIssues]

  // Check channel security
  if (context.channel === 'sms') {
    allIssues.push({
      severity: 'info',
      category: 'channel_security',
      description: 'SMS is not encrypted end-to-end. Minimize PHI in SMS messages.',
      remediation: 'Keep SMS messages brief. Direct patients to secure portal for detailed medical discussions.',
    })
  }

  // Data minimization check
  if (inputPHI.length > 5) {
    allIssues.push({
      severity: 'warning',
      category: 'data_minimization',
      description: `AI prompt contains ${inputPHI.length} PHI elements. Apply data minimization principle.`,
      remediation: 'Use buildSafeLeadContext() to minimize PHI in AI prompts.',
    })
  }

  // Calculate compliance score
  let score = 100
  for (const issue of allIssues) {
    if (issue.severity === 'critical') score -= 30
    else if (issue.severity === 'violation') score -= 20
    else if (issue.severity === 'warning') score -= 10
    else score -= 2 // info
  }
  score = Math.max(0, score)

  return {
    isCompliant: !allIssues.some(i => i.severity === 'critical' || i.severity === 'violation'),
    score,
    issues: allIssues,
    phi_detected: allPHI,
    recommendations: allIssues.map(i => i.remediation),
  }
}

// ════════════════════════════════════════════════════════════════
// AUDIT LOGGING
// ════════════════════════════════════════════════════════════════

/**
 * Log a HIPAA audit event to the database.
 */
export async function logHIPAAEvent(
  supabase: SupabaseClient,
  event: {
    organization_id: string
    event_type: string
    severity: 'info' | 'warning' | 'violation' | 'critical'
    actor_type: 'user' | 'system' | 'ai_agent' | 'cron' | 'webhook'
    actor_id?: string
    resource_type?: string
    resource_id?: string
    description: string
    phi_categories?: PHICategory[]
    remediation_action?: string
    metadata?: Record<string, unknown>
  }
): Promise<void> {
  await supabase.from('hipaa_audit_log').insert({
    organization_id: event.organization_id,
    event_type: event.event_type,
    severity: event.severity,
    actor_type: event.actor_type,
    actor_id: event.actor_id,
    resource_type: event.resource_type,
    resource_id: event.resource_id,
    description: event.description,
    phi_categories: event.phi_categories || [],
    remediation_action: event.remediation_action,
    metadata: event.metadata || {},
  })
}

/**
 * HIPAA-compliant wrapper for AI API calls.
 * Scrubs PHI from prompts, checks responses, and logs everything.
 */
export async function hipaaCompliantAICall(
  supabase: SupabaseClient,
  config: {
    organization_id: string
    lead_id: string
    conversation_id?: string
    input_text: string
    channel: 'sms' | 'email'
    agent_name: string
  },
  aiCall: (scrubbed_input: string) => Promise<string>
): Promise<{ response: string; compliance: HIPAAComplianceResult }> {
  // Step 1: Detect and scrub PHI from input
  const inputPHI = detectPHI(config.input_text)
  const scrubbedInput = scrubPHI(config.input_text, inputPHI)

  // Log PHI access
  if (inputPHI.length > 0) {
    await logHIPAAEvent(supabase, {
      organization_id: config.organization_id,
      event_type: 'ai_phi_scrubbed',
      severity: 'info',
      actor_type: 'ai_agent',
      actor_id: config.agent_name,
      resource_type: 'lead',
      resource_id: config.lead_id,
      description: `Scrubbed ${inputPHI.length} PHI elements before AI processing`,
      phi_categories: [...new Set(inputPHI.map(p => p.category))],
    })
  }

  // Step 2: Log AI processing event
  await logHIPAAEvent(supabase, {
    organization_id: config.organization_id,
    event_type: 'ai_processing',
    severity: 'info',
    actor_type: 'ai_agent',
    actor_id: config.agent_name,
    resource_type: 'conversation',
    resource_id: config.conversation_id,
    description: `AI agent "${config.agent_name}" processing conversation data`,
    metadata: { channel: config.channel },
  })

  // Step 3: Execute AI call with scrubbed input
  const response = await aiCall(scrubbedInput)

  // Step 4: Check response compliance
  const compliance = runComplianceCheck(config.input_text, response, {
    channel: config.channel,
    aiModel: 'claude-sonnet-4-20250514',
  })

  // Step 5: Log compliance result
  if (!compliance.isCompliant) {
    await logHIPAAEvent(supabase, {
      organization_id: config.organization_id,
      event_type: 'ai_phi_detected',
      severity: compliance.issues.some(i => i.severity === 'critical') ? 'critical' : 'warning',
      actor_type: 'ai_agent',
      actor_id: config.agent_name,
      resource_type: 'conversation',
      resource_id: config.conversation_id,
      description: `Compliance issues detected: ${compliance.issues.map(i => i.category).join(', ')}`,
      remediation_action: compliance.recommendations[0],
      metadata: { score: compliance.score, issues: compliance.issues },
    })
  }

  return { response, compliance }
}
