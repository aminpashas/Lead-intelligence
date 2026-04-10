/**
 * Prompt Injection Detection
 *
 * Detects and neutralizes prompt injection attempts in user-provided text
 * before it's sent to AI models. This is critical for the Twilio webhook
 * where raw patient SMS is included in Claude prompts.
 */

// Patterns that indicate prompt injection attempts
const INJECTION_PATTERNS: Array<{ pattern: RegExp; severity: 'high' | 'medium'; label: string }> = [
  // Direct instruction override
  { pattern: /ignore\s+(?:all\s+)?(?:(?:your|previous|prior|above)\s+)+(?:instructions|rules|guidelines|directives|system\s+prompt)/i, severity: 'high', label: 'instruction_override' },
  { pattern: /disregard\s+(?:all\s+)?(?:your|previous|prior|above)\s+(?:instructions|rules|guidelines)/i, severity: 'high', label: 'instruction_override' },
  { pattern: /forget\s+(?:all\s+)?(?:your|everything|previous)\s+(?:instructions|rules)/i, severity: 'high', label: 'instruction_override' },

  // Role manipulation
  { pattern: /you\s+are\s+now\s+(?:a|an|no\s+longer)/i, severity: 'high', label: 'role_manipulation' },
  { pattern: /act\s+as\s+(?:a|an)\s+(?:different|new|hacker|admin)/i, severity: 'high', label: 'role_manipulation' },
  { pattern: /pretend\s+(?:you(?:'re|\s+are)\s+|to\s+be\s+)/i, severity: 'medium', label: 'role_manipulation' },
  { pattern: /switch\s+to\s+(?:a\s+)?(?:different|new|developer|admin|unrestricted)\s+mode/i, severity: 'high', label: 'role_manipulation' },

  // System prompt extraction
  { pattern: /(?:show|tell|reveal|display|output|print|repeat|list)\s+(?:me\s+)?(?:your|the)\s+(?:system|initial|original)\s+(?:prompt|instructions|message)/i, severity: 'high', label: 'system_prompt_extraction' },
  { pattern: /what\s+(?:are|were)\s+your\s+(?:system|original|initial)\s+(?:instructions|prompt|directives)/i, severity: 'high', label: 'system_prompt_extraction' },

  // Data exfiltration
  { pattern: /(?:tell|show|give|send|list|display)\s+(?:me\s+)?(?:all|other|every)\s+(?:patient|lead|customer|user)\s+(?:data|info|information|records|details|names|numbers)/i, severity: 'high', label: 'data_exfiltration' },
  { pattern: /(?:access|retrieve|fetch|query|search)\s+(?:the\s+)?(?:database|records|other\s+patients)/i, severity: 'high', label: 'data_exfiltration' },

  // Delimiter injection
  { pattern: /```\s*system/i, severity: 'high', label: 'delimiter_injection' },
  { pattern: /\[SYSTEM\]/i, severity: 'medium', label: 'delimiter_injection' },
  { pattern: /<\/?system>/i, severity: 'high', label: 'delimiter_injection' },
  { pattern: /###\s*(?:SYSTEM|INSTRUCTIONS|NEW\s+INSTRUCTIONS)/i, severity: 'high', label: 'delimiter_injection' },

  // Jailbreak patterns
  { pattern: /(?:DAN|do\s+anything\s+now|developer\s+mode|unrestricted\s+mode|jailbreak)/i, severity: 'high', label: 'jailbreak' },
]

export type InjectionDetectionResult = {
  isClean: boolean
  detections: Array<{
    pattern: string
    severity: 'high' | 'medium'
    matchedText: string
  }>
  sanitizedText: string
}

/**
 * Detect prompt injection attempts in user input.
 */
export function detectPromptInjection(text: string): InjectionDetectionResult {
  const detections: InjectionDetectionResult['detections'] = []

  for (const { pattern, severity, label } of INJECTION_PATTERNS) {
    const match = text.match(pattern)
    if (match) {
      detections.push({
        pattern: label,
        severity,
        matchedText: match[0],
      })
    }
  }

  const hasHighSeverity = detections.some((d) => d.severity === 'high')

  return {
    isClean: detections.length === 0,
    detections,
    sanitizedText: hasHighSeverity ? sanitizeInput(text) : text,
  }
}

/**
 * Sanitize text by wrapping it clearly as user content.
 * This doesn't modify the text itself but adds context markers
 * that help the AI model distinguish user content from instructions.
 */
function sanitizeInput(text: string): string {
  // Remove obvious injection delimiters
  let sanitized = text
    .replace(/<\/?system>/gi, '')
    .replace(/```\s*system/gi, '```')
    .replace(/\[SYSTEM\]/gi, '')
    .replace(/###\s*(?:SYSTEM|INSTRUCTIONS|NEW\s+INSTRUCTIONS)/gi, '')

  return sanitized
}

/**
 * Build a prompt-injection-resistant system instruction.
 * Adds clear boundaries between instructions and user content.
 */
export function wrapUserContent(userText: string): string {
  return `<user_message>\n${userText}\n</user_message>`
}
