/**
 * Vendor categorization for fully-loaded CAC math.
 *
 * Three buckets:
 *   acquisition  — money spent ACQUIRING patients (ad media + agency fees)
 *   platform     — software costs that scale with the business (Twilio, Resend, etc.)
 *   other        — everything else (rent, supplies, salaries, taxes — not in CAC)
 *
 * The CAC dashboard divides (acquisition + platform) by new patients.
 * Pure media-spend CAC = acquisition / new patients.
 *
 * Rules are conservative — when uncertain we tag 'other' so we don't over-state CAC.
 * Staff can override any line item via the dashboard (category_overridden=true).
 */

export type ExpenseCategory = 'acquisition' | 'platform' | 'other'

export type Categorization = {
  category: ExpenseCategory
  subcategory: string | null
}

// Order matters — first matching rule wins. Specific patterns BEFORE generic ones.
type Rule = {
  pattern: RegExp
  category: ExpenseCategory
  subcategory: string
}

const RULES: Rule[] = [
  // ── ACQUISITION: ad media ──
  { pattern: /\bgoogle\b.*\b(ads|adwords)\b|google\s*adwords|google\.com\/ads/i, category: 'acquisition', subcategory: 'google_ads' },
  { pattern: /\bmeta\b|\bfacebook\b.*\bads?\b|fb\.com|facebook\.com/i, category: 'acquisition', subcategory: 'meta_ads' },
  { pattern: /\btiktok\b/i, category: 'acquisition', subcategory: 'tiktok_ads' },
  { pattern: /\bbing\b.*\bads?\b|microsoft.*ads/i, category: 'acquisition', subcategory: 'bing_ads' },
  { pattern: /\blinkedin\b.*\bads?\b/i, category: 'acquisition', subcategory: 'linkedin_ads' },

  // ── ACQUISITION: agency fees ──
  { pattern: /\bdds\s*marketing\b|ddsmarketing/i, category: 'acquisition', subcategory: 'agency_dds' },
  { pattern: /\b(agency|marketing)\s*fee\b/i, category: 'acquisition', subcategory: 'agency_other' },

  // ── PLATFORM: comms ──
  { pattern: /\btwilio\b/i, category: 'platform', subcategory: 'twilio' },
  { pattern: /\bresend\b/i, category: 'platform', subcategory: 'resend' },
  { pattern: /\bsendgrid\b/i, category: 'platform', subcategory: 'sendgrid' },
  { pattern: /\bretell\b/i, category: 'platform', subcategory: 'retell' },
  { pattern: /\bvapi\b/i, category: 'platform', subcategory: 'vapi' },
  { pattern: /\bcal\.com\b|cal\s*inc/i, category: 'platform', subcategory: 'cal_com' },

  // ── PLATFORM: infra ──
  { pattern: /\bvercel\b/i, category: 'platform', subcategory: 'vercel' },
  { pattern: /\bsupabase\b/i, category: 'platform', subcategory: 'supabase' },
  { pattern: /\bcloudflare\b/i, category: 'platform', subcategory: 'cloudflare' },
  { pattern: /\baws\b|amazon\s*web/i, category: 'platform', subcategory: 'aws' },

  // ── PLATFORM: AI ──
  { pattern: /\banthropic\b|claude/i, category: 'platform', subcategory: 'anthropic' },
  { pattern: /\bopenai\b|gpt/i, category: 'platform', subcategory: 'openai' },

  // ── PLATFORM: clinical / billing ──
  { pattern: /\bcarestack\b|good\s*methods/i, category: 'platform', subcategory: 'carestack' },
  { pattern: /\bstripe\b/i, category: 'platform', subcategory: 'stripe' },
  { pattern: /\bsunbit\b/i, category: 'platform', subcategory: 'sunbit' },
  { pattern: /\bcarecredit\b/i, category: 'platform', subcategory: 'carecredit' },

  // ── PLATFORM: enrichment / data ──
  { pattern: /\bzerobounce\b/i, category: 'platform', subcategory: 'zerobounce' },
  { pattern: /\bmaxmind\b/i, category: 'platform', subcategory: 'maxmind' },
  { pattern: /\bexperian\b/i, category: 'platform', subcategory: 'experian' },
  { pattern: /\bwindsor\b/i, category: 'platform', subcategory: 'windsor' },
]

export function categorizeVendor(vendorName: string | null, description: string | null = null): Categorization {
  const haystack = `${vendorName ?? ''} ${description ?? ''}`.trim()
  if (!haystack) return { category: 'other', subcategory: null }

  for (const rule of RULES) {
    if (rule.pattern.test(haystack)) {
      return { category: rule.category, subcategory: rule.subcategory }
    }
  }
  return { category: 'other', subcategory: null }
}

export function normalizeVendor(vendorName: string | null): string | null {
  if (!vendorName) return null
  return vendorName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}
