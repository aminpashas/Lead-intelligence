/**
 * Experian ConsumerView Integration
 *
 * Marketing-grade consumer data enrichment — NO credit pull.
 * Returns: estimated income, credit tier (Mosaic/FSS), homeowner status,
 * household composition, and 300+ demographic/financial variables.
 *
 * This is NOT a credit report. It uses Experian's marketing database
 * (ConsumerView) which requires a business account but does NOT
 * impact the consumer's credit score in any way.
 *
 * Required env vars:
 * - EXPERIAN_CLIENT_ID: OAuth client ID from developer.experian.com
 * - EXPERIAN_CLIENT_SECRET: OAuth client secret
 * - EXPERIAN_USERNAME: Experian account username
 * - EXPERIAN_PASSWORD: Experian account password
 * - EXPERIAN_SUBCODE: Account subcode (optional, for multi-location)
 */

import { withRetry } from '@/lib/retry'

const EXPERIAN_AUTH_URL = 'https://us-api.experian.com/oauth2/v1/token'
const EXPERIAN_CONSUMERVIEW_URL = 'https://us-api.experian.com/consumerview/v1/enrich'
const RETRY_CONFIG = { maxAttempts: 2, baseDelayMs: 2000, maxDelayMs: 10_000 }

// ── Types ──────────────────────────────────────────────────

export type ExperianConsumerResult = {
  // Financial
  estimated_income_range: { min: number; max: number } | null
  income_code: string | null
  credit_tier: 'super_prime' | 'prime' | 'near_prime' | 'sub_prime' | 'deep_sub_prime' | 'unknown'
  financial_segment: string | null          // Experian Financial Strategy Segment
  mosaic_group: string | null               // Mosaic lifestyle segment (e.g., "A01 - American Royalty")
  mosaic_type: string | null

  // Property
  homeowner: boolean | null
  home_value_range: { min: number; max: number } | null
  length_of_residence_years: number | null
  dwelling_type: 'single_family' | 'multi_family' | 'condo' | 'apartment' | 'mobile' | 'unknown' | null

  // Demographics
  estimated_age: number | null
  marital_status: 'married' | 'single' | 'unknown' | null
  household_size: number | null
  children_present: boolean | null
  education_level: string | null
  occupation_group: string | null

  // Behavioral
  mail_responder: boolean | null
  online_buyer: boolean | null
  credit_card_user: boolean | null
  auto_loan_likely: boolean | null
  investment_active: boolean | null

  // Meta
  match_confidence: number  // 0-1, how well the input matched
  data_freshness: string | null
}

// ── Authentication ─────────────────────────────────────────

let cachedToken: { token: string; expiresAt: number } | null = null

async function getExperianToken(): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token
  }

  const clientId = process.env.EXPERIAN_CLIENT_ID
  const clientSecret = process.env.EXPERIAN_CLIENT_SECRET
  const username = process.env.EXPERIAN_USERNAME
  const password = process.env.EXPERIAN_PASSWORD

  if (!clientId || !clientSecret) {
    throw new Error('Experian credentials not configured')
  }

  const response = await fetch(EXPERIAN_AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'client_id': clientId,
      'client_secret': clientSecret,
    },
    body: JSON.stringify({
      username: username || '',
      password: password || '',
    }),
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    throw new Error(`Experian auth failed: ${response.status}`)
  }

  const data = await response.json()
  const token = data.access_token
  const expiresIn = (data.expires_in || 1800) * 1000 // default 30 min

  cachedToken = {
    token,
    expiresAt: Date.now() + expiresIn,
  }

  return token
}

// ── Main Enrichment Call ───────────────────────────────────

/**
 * Enrich a consumer record via Experian ConsumerView.
 * NO credit pull — uses marketing database only.
 *
 * Minimum required: first_name + last_name + (address OR zip_code)
 */
export async function enrichWithExperian(input: {
  first_name: string
  last_name: string | null
  address?: string | null
  city?: string | null
  state?: string | null
  zip_code?: string | null
  email?: string | null
  phone?: string | null
  date_of_birth?: string | null
}): Promise<ExperianConsumerResult> {
  const clientId = process.env.EXPERIAN_CLIENT_ID
  if (!clientId) {
    return buildFallbackResult()
  }

  // Must have at least name + some location
  if (!input.first_name || (!input.zip_code && !input.state)) {
    return buildFallbackResult()
  }

  return withRetry(async () => {
    const token = await getExperianToken()
    const subcode = process.env.EXPERIAN_SUBCODE || ''

    const requestBody: Record<string, unknown> = {
      firstName: input.first_name,
      lastName: input.last_name || '',
      ...(input.address && { address: input.address }),
      ...(input.city && { city: input.city }),
      ...(input.state && { state: input.state }),
      ...(input.zip_code && { zip: input.zip_code }),
      ...(input.email && { email: input.email }),
      ...(input.phone && { phone: input.phone }),
      ...(input.date_of_birth && { dateOfBirth: input.date_of_birth }),
      ...(subcode && { subcode }),
      // Request specific variable groups
      variableGroups: [
        'INCOME',
        'CREDIT',
        'PROPERTY',
        'DEMOGRAPHICS',
        'LIFESTYLE',
        'FINANCIAL',
        'MOSAIC',
      ],
    }

    const response = await fetch(EXPERIAN_CONSUMERVIEW_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'client_id': clientId,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(15_000),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Experian ConsumerView error ${response.status}: ${errorText}`)
    }

    const data = await response.json()
    return mapExperianResponse(data)
  }, RETRY_CONFIG)
}

// ── Response Mapping ───────────────────────────────────────

function mapExperianResponse(data: Record<string, unknown>): ExperianConsumerResult {
  // Experian returns variables in a flat structure or nested under groups
  // The exact field names depend on the variable set purchased
  const vars = (data.variables || data.consumerData || data) as Record<string, unknown>

  // Income estimation
  const incomeCode = vars.estimatedIncome || vars.incomeCode || vars.HOUSEHOLD_INCOME_CODE
  const incomeRange = mapIncomeCode(incomeCode as string)

  // Credit tier from Financial Strategy Segment (FSS)
  const fssCode = vars.financialSegment || vars.FSS_CODE || vars.financial_strategy_segment
  const creditTier = mapFSSToCreditTier(fssCode as string)

  // Mosaic
  const mosaicGroup = (vars.mosaicGroup || vars.MOSAIC_GROUP || vars.mosaic_household_group) as string | null
  const mosaicType = (vars.mosaicType || vars.MOSAIC_TYPE || vars.mosaic_household_type) as string | null

  // Property
  const homeownerFlag = vars.homeowner || vars.HOME_OWNER || vars.homeOwnerRenter
  const homeowner = homeownerFlag === 'Y' || homeownerFlag === 'O' || homeownerFlag === true || homeownerFlag === 'homeowner'

  const homeValueCode = vars.homeValue || vars.HOME_VALUE_CODE || vars.estimated_home_value
  const homeValueRange = mapHomeValueCode(homeValueCode as string)

  const lorYears = vars.lengthOfResidence || vars.LENGTH_OF_RESIDENCE || vars.lor_years
  const dwellingCode = vars.dwellingType || vars.DWELLING_TYPE

  // Demographics
  const age = vars.exactAge || vars.EXACT_AGE || vars.estimated_age
  const maritalCode = vars.maritalStatus || vars.MARITAL_STATUS
  const hhSize = vars.householdSize || vars.HOUSEHOLD_SIZE || vars.number_of_persons
  const childrenFlag = vars.childrenPresent || vars.CHILDREN_PRESENT
  const educationCode = vars.educationLevel || vars.EDUCATION_CODE
  const occupationCode = vars.occupation || vars.OCCUPATION_CODE

  // Behavioral
  const mailResponder = vars.mailResponder || vars.MAIL_ORDER_BUYER
  const onlineBuyer = vars.onlineBuyer || vars.ONLINE_PURCHASER
  const creditCardUser = vars.creditCardUser || vars.BANKCARD_HOLDER
  const investmentActive = vars.investmentActive || vars.INVESTMENT_ACTIVE

  // Match confidence
  const matchLevel = vars.matchLevel || vars.MATCH_LEVEL || vars.confidence
  const matchConfidence = typeof matchLevel === 'number' ? matchLevel / 100 :
    matchLevel === 'HIGH' ? 0.95 : matchLevel === 'MEDIUM' ? 0.7 : 0.4

  return {
    estimated_income_range: incomeRange,
    income_code: (incomeCode as string) || null,
    credit_tier: creditTier,
    financial_segment: (fssCode as string) || null,
    mosaic_group: mosaicGroup || null,
    mosaic_type: mosaicType || null,
    homeowner: homeowner || null,
    home_value_range: homeValueRange,
    length_of_residence_years: typeof lorYears === 'number' ? lorYears : null,
    dwelling_type: mapDwellingType(dwellingCode as string),
    estimated_age: typeof age === 'number' ? age : null,
    marital_status: maritalCode === 'M' ? 'married' : maritalCode === 'S' ? 'single' : 'unknown',
    household_size: typeof hhSize === 'number' ? hhSize : null,
    children_present: childrenFlag === 'Y' || childrenFlag === true || null,
    education_level: (educationCode as string) || null,
    occupation_group: (occupationCode as string) || null,
    mail_responder: mailResponder === 'Y' || mailResponder === true || null,
    online_buyer: onlineBuyer === 'Y' || onlineBuyer === true || null,
    credit_card_user: creditCardUser === 'Y' || creditCardUser === true || null,
    auto_loan_likely: null, // Not directly available
    investment_active: investmentActive === 'Y' || investmentActive === true || null,
    match_confidence: matchConfidence as number,
    data_freshness: (vars.dataDate || vars.DATA_DATE) as string | null,
  }
}

// ── Code Mapping Tables ────────────────────────────────────

function mapIncomeCode(code: string | null | undefined): { min: number; max: number } | null {
  if (!code) return null
  // Experian income codes (standard ranges)
  const incomeMap: Record<string, { min: number; max: number }> = {
    'A': { min: 0, max: 15000 },
    'B': { min: 15000, max: 20000 },
    'C': { min: 20000, max: 30000 },
    'D': { min: 30000, max: 40000 },
    'E': { min: 40000, max: 50000 },
    'F': { min: 50000, max: 75000 },
    'G': { min: 75000, max: 100000 },
    'H': { min: 100000, max: 125000 },
    'I': { min: 125000, max: 150000 },
    'J': { min: 150000, max: 175000 },
    'K': { min: 175000, max: 200000 },
    'L': { min: 200000, max: 250000 },
    'M': { min: 250000, max: 500000 },
    'N': { min: 500000, max: 1000000 },
    // Numeric codes
    '1': { min: 0, max: 15000 },
    '2': { min: 15000, max: 25000 },
    '3': { min: 25000, max: 35000 },
    '4': { min: 35000, max: 50000 },
    '5': { min: 50000, max: 75000 },
    '6': { min: 75000, max: 100000 },
    '7': { min: 100000, max: 150000 },
    '8': { min: 150000, max: 250000 },
    '9': { min: 250000, max: 1000000 },
  }
  return incomeMap[code.toUpperCase()] || null
}

/**
 * Map Experian Financial Strategy Segment (FSS) to credit tier.
 * FSS groups consumers by financial behavior, not actual credit score,
 * but it correlates strongly with creditworthiness.
 */
function mapFSSToCreditTier(code: string | null | undefined): ExperianConsumerResult['credit_tier'] {
  if (!code) return 'unknown'
  const prefix = code.substring(0, 2).toUpperCase()

  // FSS groups (simplified mapping):
  // Group A: Affluent established - super prime
  // Group B: Moderately affluent - prime
  // Group C: Middle income stable - prime/near prime
  // Group D: Younger/mobile - near prime
  // Group E: Credit active but stretched - near prime/sub prime
  // Group F: Credit challenged - sub prime
  // Group G: Credit inactive/thin file - unknown

  const tierMap: Record<string, ExperianConsumerResult['credit_tier']> = {
    'A0': 'super_prime', 'A1': 'super_prime', 'A2': 'super_prime',
    'B0': 'prime', 'B1': 'prime', 'B2': 'prime',
    'C0': 'prime', 'C1': 'prime', 'C2': 'near_prime',
    'D0': 'near_prime', 'D1': 'near_prime', 'D2': 'near_prime',
    'E0': 'near_prime', 'E1': 'sub_prime', 'E2': 'sub_prime',
    'F0': 'sub_prime', 'F1': 'sub_prime', 'F2': 'deep_sub_prime',
    'G0': 'unknown', 'G1': 'unknown',
  }

  return tierMap[prefix] || 'unknown'
}

function mapHomeValueCode(code: string | null | undefined): { min: number; max: number } | null {
  if (!code) return null
  const valueMap: Record<string, { min: number; max: number }> = {
    'A': { min: 0, max: 50000 },
    'B': { min: 50000, max: 100000 },
    'C': { min: 100000, max: 150000 },
    'D': { min: 150000, max: 200000 },
    'E': { min: 200000, max: 250000 },
    'F': { min: 250000, max: 300000 },
    'G': { min: 300000, max: 400000 },
    'H': { min: 400000, max: 500000 },
    'I': { min: 500000, max: 750000 },
    'J': { min: 750000, max: 1000000 },
    'K': { min: 1000000, max: 2000000 },
  }
  return valueMap[code.toUpperCase()] || null
}

function mapDwellingType(code: string | null | undefined): ExperianConsumerResult['dwelling_type'] {
  if (!code) return null
  switch (code.toUpperCase()) {
    case 'S': case 'SFR': return 'single_family'
    case 'M': case 'MFR': return 'multi_family'
    case 'C': case 'CONDO': return 'condo'
    case 'A': case 'APT': return 'apartment'
    case 'T': case 'MOBILE': return 'mobile'
    default: return 'unknown'
  }
}

// ── Fallback ───────────────────────────────────────────────

function buildFallbackResult(): ExperianConsumerResult {
  return {
    estimated_income_range: null,
    income_code: null,
    credit_tier: 'unknown',
    financial_segment: null,
    mosaic_group: null,
    mosaic_type: null,
    homeowner: null,
    home_value_range: null,
    length_of_residence_years: null,
    dwelling_type: null,
    estimated_age: null,
    marital_status: 'unknown',
    household_size: null,
    children_present: null,
    education_level: null,
    occupation_group: null,
    mail_responder: null,
    online_buyer: null,
    credit_card_user: null,
    auto_loan_likely: null,
    investment_active: null,
    match_confidence: 0,
    data_freshness: null,
  }
}

export function experianConfidence(result: ExperianConsumerResult): number {
  if (result.match_confidence <= 0) return 0
  if (result.credit_tier === 'unknown' && !result.estimated_income_range) return 0.2
  return result.match_confidence
}
