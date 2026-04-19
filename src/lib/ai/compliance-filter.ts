/**
 * Compliance filter — last line of defense before any AI-generated message goes outbound.
 *
 * Brief reference: §3.2 — "Always run through a profanity + compliance filter before send."
 *
 * Catches:
 *   - Profanity / slurs
 *   - Forbidden medical claims (cures, guarantees, FDA-restricted language)
 *   - Pricing claims with specific dollar amounts (must be reviewed by staff)
 *   - PII leaks (SSN, full credit card)
 *   - URLs that aren't on an allowlist (link injection guard)
 *   - Empty / suspiciously short / suspiciously long output
 *
 * This is deliberately rule-based, not Claude-based: we don't want the gate itself to be a
 * Claude call (cost + latency on every send). For ambiguous cases the filter recommends
 * escalation to staff via `requiresReview = true`.
 */

export type ComplianceCheck = {
  allowed: boolean
  reasons: string[]                     // human-readable failure reasons (empty if allowed)
  requiresReview: boolean               // true = escalate to staff even if allowed=true
  redactedBody?: string                 // optional: filter scrubbed something but the result is sendable
}

export type ComplianceContext = {
  channel: 'sms' | 'email' | 'voice'
  /** Allowlist of bare hosts. Falls back to NEXT_PUBLIC_APP_URL host. */
  allowedHosts?: string[]
}

// ── pattern banks ────────────────────────────────────────────────────────────────

// Conservative profanity list. We keep it short and obvious; every bad word here is
// genuinely never appropriate in a clinical-marketing context. Avoid scunthorpe-style
// over-matching — match WHOLE WORDS only.
const PROFANITY = [
  'fuck', 'shit', 'bitch', 'cunt', 'dick', 'pussy', 'asshole', 'bastard',
  'damn', 'hell', // these two are "soft" — flagged but not blocking
  'nigger', 'nigga', 'faggot', 'retard', 'tranny',
]
const HARD_PROFANITY = new Set(PROFANITY.filter((w) => !['damn', 'hell'].includes(w)))

// Forbidden medical claim keywords (FDA / ADA guidance for elective dental implants).
// We're not a regulated medical-device manufacturer, but absolute-claim language ("guaranteed",
// "permanent cure") creates legal exposure and should be staff-reviewed.
const FORBIDDEN_CLAIMS = [
  /\b(cure|cures|cured)\b/i,
  /\bguarantee[ds]?\b/i,
  /\b100%\s*(safe|effective|painless|success)\b/i,
  /\bFDA[\s-]?approved\b/i,        // we don't make this claim about a procedure
  /\bbest\s+in\s+(the\s+)?(world|country|state)\b/i,
  /\bmiracle\b/i,
]

// Specific dollar amounts in outbound — pricing language must be staff-reviewed because
// quotes vary by case and incorrect quotes create contract exposure.
const PRICE_PATTERNS = [
  /\$\s?\d{1,3}(,\d{3})+/,                // $40,000
  /\$\s?\d{4,}/,                          // $40000
  /\b\d{1,3}\s?(k|K)\b/,                  // 40k
  /\bonly\s+\$\d/i,                       // "only $..."
]

// PII leak patterns
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/
const CREDIT_CARD_PATTERN = /\b(?:\d[ -]?){13,16}\b/

// URL extraction
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi

// Length sanity
const MIN_LENGTH_CHARS = 8
const MAX_SMS_CHARS = 1600           // 10 SMS segments — anything beyond is almost certainly a bug
const MAX_EMAIL_CHARS = 50_000

// ── main entry ───────────────────────────────────────────────────────────────────

export function checkCompliance(body: string, ctx: ComplianceContext): ComplianceCheck {
  const reasons: string[] = []
  let requiresReview = false

  const trimmed = (body || '').trim()

  // ── empty / length sanity ──
  if (trimmed.length < MIN_LENGTH_CHARS) {
    return { allowed: false, reasons: ['empty_or_too_short'], requiresReview: false }
  }

  const maxLen = ctx.channel === 'sms' ? MAX_SMS_CHARS : MAX_EMAIL_CHARS
  if (trimmed.length > maxLen) {
    return { allowed: false, reasons: [`exceeds_max_length_${ctx.channel}`], requiresReview: false }
  }

  const lower = trimmed.toLowerCase()
  const wordSet = new Set(lower.split(/[^a-z0-9']+/).filter(Boolean))

  // ── profanity ──
  const profanityHits = PROFANITY.filter((w) => wordSet.has(w))
  if (profanityHits.length > 0) {
    const hardHits = profanityHits.filter((w) => HARD_PROFANITY.has(w))
    if (hardHits.length > 0) {
      reasons.push(`profanity:${hardHits.join(',')}`)
      // Hard profanity is an absolute block.
      return { allowed: false, reasons, requiresReview: false }
    }
    // Soft profanity ("damn", "hell") flags for review but doesn't block.
    requiresReview = true
    reasons.push(`soft_profanity:${profanityHits.join(',')}`)
  }

  // ── forbidden medical claims ──
  for (const pattern of FORBIDDEN_CLAIMS) {
    const match = trimmed.match(pattern)
    if (match) {
      reasons.push(`forbidden_claim:${match[0]}`)
      requiresReview = true
    }
  }

  // ── pricing claims ──
  for (const pattern of PRICE_PATTERNS) {
    if (pattern.test(trimmed)) {
      reasons.push('contains_pricing')
      requiresReview = true
      break
    }
  }

  // ── PII leaks (always block — we never want to send a SSN/CC outbound) ──
  if (SSN_PATTERN.test(trimmed)) {
    return { allowed: false, reasons: ['pii_ssn'], requiresReview: false }
  }
  if (CREDIT_CARD_PATTERN.test(trimmed)) {
    return { allowed: false, reasons: ['pii_credit_card'], requiresReview: false }
  }

  // ── URL allowlist ──
  const urls = trimmed.match(URL_PATTERN) || []
  if (urls.length > 0) {
    const allowed = buildAllowedHosts(ctx.allowedHosts)
    for (const url of urls) {
      let host: string
      try {
        host = new URL(url).hostname.toLowerCase()
      } catch {
        reasons.push(`malformed_url:${url}`)
        return { allowed: false, reasons, requiresReview: false }
      }
      const isAllowed = allowed.some((h) => host === h || host.endsWith('.' + h))
      if (!isAllowed) {
        reasons.push(`untrusted_url:${host}`)
        requiresReview = true
      }
    }
  }

  return {
    allowed: true,
    reasons,
    requiresReview,
  }
}

function buildAllowedHosts(extra?: string[]): string[] {
  const hosts = new Set<string>([
    'cal.com',
    'dionhealth.com',
    'aurea.health',
    'g.page',          // Google review short links
    'maps.app.goo.gl', // Google maps share links
  ])

  // Pull our own app host from env so the unsubscribe link in email footers is always allowed.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (appUrl) {
    try {
      hosts.add(new URL(appUrl).hostname.toLowerCase())
    } catch {
      // ignore malformed env
    }
  }

  for (const h of extra || []) {
    hosts.add(h.toLowerCase())
  }

  return [...hosts]
}
