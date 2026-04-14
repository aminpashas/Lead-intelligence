/**
 * Unified Post-Encounter Intelligence Processor v2
 *
 * FULL EXTRACTION ENGINE — After ANY interaction (Voice, SMS, Email):
 *
 * 1. CLINICAL: dental condition, dentures, medical history, smoker status
 * 2. FINANCIAL: insurance, budget, financing interest, competitor pricing
 * 3. PSYCHOLOGICAL: DISC profile, anxiety, motivation, objections, buying signals
 * 4. BACKGROUND: age, gender, location, occupation, referral source, competitors
 * 5. SALES: appointment status, urgency, decision makers, treatment interest
 * 6. ENGAGEMENT: AI score with breakdown, qualification tier, auto-tags, summary
 *
 * Updates: leads (74+ fields), lead_activities, messages, conversations, ai_interactions
 */

type Channel = 'voice' | 'sms' | 'email'

// ════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════

export type ExtractedIntelligence = {
  // Identity
  firstName: string | null
  lastName: string | null
  email: string | null
  phone: string | null

  // Clinical
  dentalCondition: string | null
  dentalConditionDetails: string | null
  currentDentalSituation: string | null
  hasDentures: boolean | null
  medicalConditions: string[]
  medications: string[]
  smoker: boolean | null

  // Financial
  hasDentalInsurance: boolean | null
  insuranceProvider: string | null
  insuranceDetails: string | null
  budgetRange: string | null
  financingInterest: string | null
  financingApproved: boolean | null
  financingAmount: number | null
  treatmentValue: number | null
  competitorPrices: Record<string, string>

  // Appointment / Timeline
  appointmentBooked: boolean
  appointmentDetails: string | null
  consultationType: string | null
  urgencyLevel: 'emergency' | 'urgent' | 'moderate' | 'low' | null
  availability: string | null

  // Psychological
  emotionalState: string | null
  anxietyLevel: number | null       // 1-10
  motivationLevel: number | null    // 1-10
  decisionStyle: string | null
  communicationStyle: string | null
  pastDentalTrauma: boolean
  buyingSignals: string[]
  objections: string[]
  objectionsResolved: string[]

  // Background
  age: number | null
  gender: string | null
  city: string | null
  state: string | null
  zipCode: string | null
  occupation: string | null
  referralSource: string | null
  competitorsVisited: string[]
  conditionDuration: string | null
  lifestyleImpact: string[]
  familyContext: string | null
  previousDentalWork: string[]
  decisionMakers: string[]

  // Content / Interests
  concerns: string[]
  treatmentInterest: string[]

  // Auto-tags
  autoTags: string[]
}

export type ScoreBreakdown = {
  clinical: number       // 0-20 — condition severity + treatment need
  financial: number      // 0-20 — ability + willingness to pay
  engagement: number     // 0-20 — responsiveness + interaction depth
  psychological: number  // 0-20 — readiness + motivation
  sales: number          // 0-20 — buying signals + appointment
}

export type EncounterData = {
  channel: Channel
  orgId: string
  leadId: string
  conversationId: string | null

  transcript: string
  summary: string | null
  sentiment: string | null
  callSuccessful: boolean

  durationSeconds?: number
  recordingUrl?: string
  retellCallId?: string

  extractedInfo?: Partial<ExtractedIntelligence>
}

type SupabaseClient = ReturnType<typeof getSupabase>

function getSupabase() {
  const { createClient } = require('@supabase/supabase-js')
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

// ════════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════════

export async function processEncounter(data: EncounterData): Promise<void> {
  const supabase = getSupabase()
  if (!supabase) {
    console.error('[Encounter] No Supabase client')
    return
  }

  console.log(`[Encounter] Processing ${data.channel} for lead ${data.leadId}`)

  try {
    const extracted = extractFromTranscript(data.transcript)

    // Merge any pre-parsed info
    if (data.extractedInfo) {
      Object.assign(extracted, data.extractedInfo)
    }

    const scoreBreakdown = calculateScoreBreakdown(data, extracted)
    const totalScore = Object.values(scoreBreakdown).reduce((a, b) => a + b, 0)
    const qualification = getQualificationTier(totalScore, extracted)
    const aiSummary = generateAISummary(data, extracted, totalScore, qualification)

    await updateLeadProfile(supabase, data, extracted, totalScore, scoreBreakdown, qualification, aiSummary)
    await logActivity(supabase, data, extracted, totalScore, qualification)
    await updateEngagementMetrics(supabase, data)
    await logAIInteraction(supabase, data, totalScore, qualification)

    if (data.channel === 'voice' && data.conversationId) {
      await logTranscriptAsMessages(supabase, data)
    }

    console.log(`[Encounter] Done: lead=${data.leadId} score=${totalScore} qual=${qualification} tags=[${extracted.autoTags.join(',')}]`)
  } catch (error) {
    console.error('[Encounter] Error:', error)
  }
}

// ════════════════════════════════════════════════════════════════
// FULL EXTRACTION ENGINE
// ════════════════════════════════════════════════════════════════

export function extractFromTranscript(transcript: string): ExtractedIntelligence {
  const t = transcript // shorthand
  const tLower = t.toLowerCase()

  const result: ExtractedIntelligence = {
    firstName: null, lastName: null, email: null, phone: null,
    dentalCondition: null, dentalConditionDetails: null, currentDentalSituation: null,
    hasDentures: null, medicalConditions: [], medications: [], smoker: null,
    hasDentalInsurance: null, insuranceProvider: null, insuranceDetails: null,
    budgetRange: null, financingInterest: null, financingApproved: null,
    financingAmount: null, treatmentValue: null, competitorPrices: {},
    appointmentBooked: false, appointmentDetails: null, consultationType: null,
    urgencyLevel: null, availability: null,
    emotionalState: null, anxietyLevel: null, motivationLevel: null,
    decisionStyle: null, communicationStyle: null, pastDentalTrauma: false,
    buyingSignals: [], objections: [], objectionsResolved: [],
    age: null, gender: null, city: null, state: null, zipCode: null,
    occupation: null, referralSource: null, competitorsVisited: [],
    conditionDuration: null, lifestyleImpact: [], familyContext: null,
    previousDentalWork: [], decisionMakers: [],
    concerns: [], treatmentInterest: [], autoTags: [],
  }

  // ── IDENTITY ──────────────────────────────────────────────
  // Only search User lines for name
  const userTextOnly = t.split('\n').filter(l => /^User:/i.test(l)).join(' ')
  const excludedNames = /^(Missing|Looking|Having|Getting|Calling|Going|Feeling|Thinking|Wanting|Working|Living|Coming|Making|Taking|Doing|Being|Saying|Trying|Asking|Needing|Seeing|Losing|Really|Something|Nothing|About|Hello|Sure|Fine|Good|Great|Just|Thank|Please|Thanks|Pretty|Actually|Absolutely)$/i
  const nameMatch = userTextOnly.match(/(?:my name is|name is|I'm|i am|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i)
  if (nameMatch) {
    const parts = nameMatch[1].trim().split(/\s+/)
    if (!excludedNames.test(parts[0])) {
      result.firstName = parts[0]
      result.lastName = parts.slice(1).join(' ') || null
    }
  }

  const emailMatch = t.match(/([a-zA-Z0-9_.+-]+\s*(?:at|@)\s*[a-zA-Z0-9-]+\s*(?:dot|\.)\s*(?:com|net|org|edu|io|co))/i)
  if (emailMatch) {
    result.email = emailMatch[1].replace(/\s*at\s*/gi, '@').replace(/\s*dot\s*/gi, '.').replace(/\s+/g, '').toLowerCase()
  }

  // ── CLINICAL ──────────────────────────────────────────────
  // Dental condition
  const conditions: string[] = []
  if (/missing\s+(?:all|most|many|several|some|a few|one|two|three|four|\d+)\s*teeth/i.test(t)) conditions.push('missing_teeth')
  if (/missing teeth/i.test(t)) conditions.push('missing_teeth')
  if (/broken|cracked|chipped/i.test(t)) conditions.push('damaged_teeth')
  if (/decay|cavit|rotten/i.test(t)) conditions.push('decay')
  if (/gum\s*(disease|recession|problem)/i.test(t)) conditions.push('gum_disease')
  if (/loose\s*teeth/i.test(t)) conditions.push('loose_teeth')
  if (/toothache|tooth\s*ache|tooth\s*pain/i.test(t)) conditions.push('tooth_pain')
  if (conditions.length > 0) result.dentalCondition = [...new Set(conditions)].join(', ')

  // Condition details
  const details: string[] = []
  if (/upper\s*(jaw|arch|teeth)/i.test(t)) details.push('upper jaw')
  if (/lower\s*(jaw|arch|teeth)/i.test(t)) details.push('lower jaw')
  if (/both\s*(jaws|arches|upper and lower)/i.test(t) || (/upper/i.test(t) && /lower/i.test(t))) details.push('both jaws')
  if (/front\s*teeth/i.test(t)) details.push('front teeth')
  if (/back\s*teeth|molar/i.test(t)) details.push('back teeth/molars')
  const missingCountMatch = t.match(/missing\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|all|most)\s*teeth/i)
  if (missingCountMatch) details.push(`${missingCountMatch[1]} teeth missing`)
  if (details.length > 0) result.dentalConditionDetails = details.join('; ')

  // Current dental situation
  if (/wear(?:ing)?\s*dentures?/i.test(t) || /have\s*dentures?/i.test(t)) {
    result.currentDentalSituation = 'wearing_dentures'
    result.hasDentures = true
  }
  if (/partial\s*(plate|denture)/i.test(t)) {
    result.currentDentalSituation = 'partial_denture'
    result.hasDentures = true
  }
  if (/flipper/i.test(t)) result.currentDentalSituation = 'flipper'
  if (/nothing\s*(right now|at the moment|currently)/i.test(t)) result.currentDentalSituation = 'nothing'

  // Medical conditions
  const medConditions: [RegExp, string][] = [
    [/diabetes|diabetic/i, 'diabetes'],
    [/blood\s*thin(ner|ning)|warfarin|coumadin|eliquis|xarelto/i, 'blood_thinner'],
    [/heart\s*(condition|disease|problem|surgery|attack)/i, 'heart_condition'],
    [/high\s*blood\s*pressure|hypertension/i, 'hypertension'],
    [/osteoporosis|bone\s*loss/i, 'osteoporosis'],
    [/cancer/i, 'cancer_history'],
    [/autoimmune/i, 'autoimmune'],
    [/thyroid/i, 'thyroid'],
    [/bisphosphonate|fosamax|boniva/i, 'bisphosphonate_use'],
  ]
  for (const [pattern, label] of medConditions) {
    if (pattern.test(t)) result.medicalConditions.push(label)
  }

  // Smoking
  if (/I\s*smoke|I\s*vape|smoker|smoking/i.test(t)) result.smoker = true
  if (/quit\s*smoking|don'?t\s*smoke|non.?smoker|stopped\s*smoking/i.test(t)) result.smoker = false

  // ── FINANCIAL ──────────────────────────────────────────────
  // Insurance
  const insuranceMentions = t.match(/(Delta Dental|Kaiser|Aetna|Cigna|MetLife|United Healthcare|Guardian|Humana|Blue Cross|Blue Shield|Anthem|GEHA|Tricare|Medicaid|Medi-Cal|Medicare)/gi)
  if (insuranceMentions) {
    result.insuranceProvider = [...new Set(insuranceMentions)].join(', ')
    result.hasDentalInsurance = true
  }
  if (/(?:I\s*(?:have|got)\s*(?:dental\s*)?insurance|I'm\s*(?:covered|insured))/i.test(t)) result.hasDentalInsurance = true
  if (/(?:no\s*insurance|don'?t\s*have\s*insurance|uninsured|cash\s*pay|out\s*of\s*pocket)/i.test(t)) result.hasDentalInsurance = false

  // Insurance details
  if (/PPO/i.test(t)) result.insuranceDetails = (result.insuranceDetails || '') + 'PPO; '
  if (/HMO/i.test(t)) result.insuranceDetails = (result.insuranceDetails || '') + 'HMO; '
  const coverageMatch = t.match(/(?:covers?|coverage)\s*(?:of\s*)?(\d+)\s*%/i)
  if (coverageMatch) result.insuranceDetails = (result.insuranceDetails || '') + `${coverageMatch[1]}% coverage; `

  // Budget
  const budgetMatch = t.match(/(?:budget|afford|spend|pay)\s*(?:of|around|about|up\s*to)?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i)
  if (budgetMatch) result.budgetRange = `$${budgetMatch[1]}`
  if (/can'?t\s*afford|too\s*(?:much|expensive)|out\s*of\s*(?:my|our)\s*(?:budget|range|price)/i.test(t)) {
    result.budgetRange = (result.budgetRange || '') + ' (price-sensitive)'
  }

  // Financing
  if (/payment\s*plan|monthly\s*payment|financ/i.test(t)) result.financingInterest = 'interested'
  if (/CareCredit|Proceed Finance|Lending Club|Cherry|Sunbit/i.test(t)) {
    result.financingInterest = 'active'
    const finCompany = t.match(/(CareCredit|Proceed Finance|Lending Club|Cherry|Sunbit)/i)
    if (finCompany) result.financingInterest = `active_${finCompany[1]}`
  }
  if (/pre.?approved|approved\s*for/i.test(t)) result.financingApproved = true

  const finAmountMatch = t.match(/(?:approved|qualified)\s*(?:for|up\s*to)\s*\$?\s*([\d,]+)/i)
  if (finAmountMatch) result.financingAmount = parseFloat(finAmountMatch[1].replace(/,/g, ''))

  // Treatment value / competitor pricing
  const priceMatch = t.match(/(?:they\s*)?(?:quoted|charged|cost|price|was)\s*(?:me\s*)?\$?\s*([\d,]+)/i)
  if (priceMatch) result.treatmentValue = parseFloat(priceMatch[1].replace(/,/g, ''))

  const competitors = ['ClearChoice', 'Nuvia', 'Aspen', 'Affordable Dentures', 'Clearchoice']
  for (const comp of competitors) {
    const compPriceMatch = t.match(new RegExp(`${comp}\\s*(?:was|quoted|charged|cost)\\s*\\$?\\s*([\\d,]+)`, 'i'))
    if (compPriceMatch) result.competitorPrices[comp] = `$${compPriceMatch[1]}`
  }

  // ── APPOINTMENT / TIMELINE ────────────────────────────────
  const appointmentPhrases = [
    /scheduled\s+for/i, /booked\s+for/i, /all\s+set\s+for/i,
    /have\s+you\s+down\s+for/i, /see\s+you\s+(?:this|next|on)/i,
    /looking\s+forward\s+to\s+seeing\s+you/i, /confirmed.*appointment/i,
  ]
  result.appointmentBooked = appointmentPhrases.some(p => p.test(t))

  if (result.appointmentBooked) {
    const apptMatch = t.match(/(?:scheduled|booked|set|down)\s+for\s+(.+?)(?:\.|!|\?|$)/i)
    if (apptMatch) result.appointmentDetails = apptMatch[1].trim().slice(0, 200)
  }

  if (/virtual|video|zoom|telehealth/i.test(t)) result.consultationType = 'virtual'
  else if (/in.?person|come\s*in|visit/i.test(t)) result.consultationType = 'in-person'
  else if (/phone\s*consultation/i.test(t)) result.consultationType = 'phone'

  // Urgency
  if (/emergency|pain|can'?t\s*wait|immediate|asap|today|right\s*away/i.test(t)) result.urgencyLevel = 'emergency'
  else if (/as\s*soon\s*as|this\s*week|urgent|hurry/i.test(t)) result.urgencyLevel = 'urgent'
  else if (/soon|next\s*(?:week|month)|when\s*(?:can|do)\s*(?:I|you)/i.test(t)) result.urgencyLevel = 'moderate'
  else if (/no\s*rush|whenever|thinking\s*about|just\s*looking|exploring/i.test(t)) result.urgencyLevel = 'low'

  // Availability
  const availMatch = t.match(/(?:available|free|prefer|best\s*(?:time|day))\s*(?:on\s*|is\s*)?(\w+(?:\s*(?:or|and)\s*\w+)*(?:\s*(?:morning|afternoon|evening))?)/i)
  if (availMatch) result.availability = availMatch[1].trim()

  // ── PSYCHOLOGICAL ─────────────────────────────────────────
  // Emotional state detection
  const emotions: [RegExp, string, number, number][] = [
    // pattern, emotion, anxiety-impact, motivation-impact
    [/excite|can'?t\s*wait|thrilled|amazing/i, 'excited', -2, 3],
    [/hopeful|looking\s*forward|optimistic/i, 'hopeful', -1, 2],
    [/nervous|anxious|worried|scared|afraid|terrified/i, 'anxious', 3, 0],
    [/frustrated|fed\s*up|sick\s*of|tired\s*of/i, 'frustrated', 1, 2],
    [/embarrass|ashamed|self.?conscious/i, 'embarrassed', 1, 3],
    [/depress|sad|unhappy|miserable/i, 'depressed', 2, 2],
    [/overwhelm|confused|don'?t\s*know/i, 'overwhelmed', 2, -1],
    [/confident|ready|determined/i, 'confident', -2, 3],
    [/skeptic|doubt|not\s*sure/i, 'skeptical', 1, -1],
  ]

  let anxietyScore = 3 // baseline
  let motivationScore = 5 // baseline

  for (const [pattern, emotion, anxDelta, motDelta] of emotions) {
    if (pattern.test(t)) {
      result.emotionalState = emotion
      anxietyScore += anxDelta
      motivationScore += motDelta
    }
  }

  result.anxietyLevel = Math.min(10, Math.max(1, anxietyScore))
  result.motivationLevel = Math.min(10, Math.max(1, motivationScore))

  // Past dental trauma
  if (/bad\s*experience|hurt\s*me|botched|malpractice|traumatic|nightmare/i.test(t)) {
    result.pastDentalTrauma = true
    result.anxietyLevel = Math.min(10, (result.anxietyLevel || 5) + 2)
  }

  // Decision-making style
  if (/need\s*to\s*think|sleep\s*on\s*it|take\s*(?:my|some)\s*time|research/i.test(t)) result.decisionStyle = 'deliberate'
  else if (/let'?s\s*do\s*it|sign\s*me\s*up|ready\s*(?:to\s*)?(?:start|go|begin)/i.test(t)) result.decisionStyle = 'decisive'
  else if (/(?:my|the)\s*(?:wife|husband|spouse|partner|family)\s*(?:needs to|has to|should|wants)/i.test(t)) result.decisionStyle = 'consensus'

  // Communication style
  const userLines = t.split('\n').filter(l => /^User:/i.test(l))
  const avgUserLength = userLines.length > 0
    ? userLines.reduce((sum, l) => sum + l.length, 0) / userLines.length
    : 0
  if (avgUserLength > 100) result.communicationStyle = 'expressive'
  else if (avgUserLength > 40) result.communicationStyle = 'balanced'
  else result.communicationStyle = 'concise'

  // Buying signals
  const buyingPatterns: [RegExp, string][] = [
    [/when\s*can\s*(?:I|we)\s*start/i, 'asking_to_start'],
    [/how\s*soon/i, 'asking_timeline'],
    [/ready\s*(?:to|now)/i, 'declares_ready'],
    [/let'?s\s*(?:do|schedule|book|go)/i, 'initiating_action'],
    [/what\s*(?:do\s*I|are)\s*(?:the\s*)?next\s*steps?/i, 'asking_next_steps'],
    [/where\s*do\s*I\s*sign/i, 'ready_to_commit'],
    [/can\s*(?:I|we)\s*start\s*(?:this|next)\s*week/i, 'immediate_intent'],
    [/I'?ve\s*(?:been\s*)?(?:wanting|waiting|thinking)/i, 'pent_up_desire'],
    [/I\s*(?:need|want|have\s*to)\s*(?:get\s*)?(?:this|it)\s*(?:done|fixed)/i, 'need_expression'],
  ]
  for (const [pattern, signal] of buyingPatterns) {
    if (pattern.test(t)) result.buyingSignals.push(signal)
  }

  // Objections
  const objectionPatterns: [RegExp, string][] = [
    [/too\s*(?:much|expensive|costly|pricey)/i, 'price_too_high'],
    [/can'?t\s*afford/i, 'cant_afford'],
    [/need\s*to\s*(?:think|discuss|talk)/i, 'needs_time'],
    [/scared|afraid|nervous|fear/i, 'fear_anxiety'],
    [/don'?t\s*(?:know|trust|believe)/i, 'trust_issue'],
    [/had\s*(?:a\s*)?bad\s*experience/i, 'past_bad_experience'],
    [/too\s*(?:far|long|many\s*visits)/i, 'logistics'],
    [/(?:my|the)\s*(?:spouse|wife|husband)\s*(?:wouldn'?t|doesn'?t|won'?t)/i, 'spousal_resistance'],
    [/what\s*if\s*it\s*(?:doesn'?t|fails|goes\s*wrong)/i, 'outcome_fear'],
    [/how\s*long\s*(?:does|will)\s*it\s*(?:last|take)/i, 'longevity_concern'],
  ]
  for (const [pattern, objection] of objectionPatterns) {
    if (pattern.test(t)) result.objections.push(objection)
  }

  // Objections resolved (agent addressed + positive response after)
  for (const objection of result.objections) {
    const lines = t.split('\n')
    for (let i = 0; i < lines.length - 2; i++) {
      if (lines[i].includes('Agent:') && lines[i + 1]?.includes('User:')) {
        const userResponse = lines[i + 1].toLowerCase()
        if (/okay|ok|makes sense|that'?s\s*(?:good|great|fair)|I\s*(?:see|understand)|alright|sounds\s*good/i.test(userResponse)) {
          result.objectionsResolved.push(objection)
          break // Only resolve once
        }
      }
    }
  }

  // ── BACKGROUND ────────────────────────────────────────────
  // Age
  const ageMatch = t.match(/I'?m\s+(\d{2})\s*(?:years?\s*old)?/i) || t.match(/(\d{2})\s*years?\s*old/i) || t.match(/I'?m\s+in\s+my\s+(\d)0s/i)
  if (ageMatch) {
    const val = parseInt(ageMatch[1])
    result.age = val < 10 ? val * 10 + 5 : val // "in my 60s" → 65
  }

  // Gender (from User lines only to avoid AI gender assumptions)
  const userText = t.split('\n').filter(l => /^User:/i.test(l)).join(' ')
  if (/\b(husband|wife|my\s*man|boyfriend|girlfriend|partner)\b/i.test(userText)) {
    // Contextual — don't assume from partner reference
  }

  // Location
  const cityMatch = t.match(/(?:I\s*(?:live|am|located)\s*(?:in|near|around))\s+([A-Z][a-zA-Z\s]+?)(?:\.|,|\s|$)/i)
  if (cityMatch) result.city = cityMatch[1].trim()

  const stateMatch = t.match(/(?:in|from)\s+([A-Z]{2})\b/)
  if (stateMatch) result.state = stateMatch[1]

  const zipMatch = t.match(/\b(\d{5})\b/)
  if (zipMatch && parseInt(zipMatch[1]) >= 10000) result.zipCode = zipMatch[1]

  // Occupation
  const occupationMatch = t.match(/(?:I'?m\s+a|I\s*work\s*(?:as|in|at)|my\s*(?:job|career|profession)\s*(?:is|as))\s+([a-zA-Z\s]+?)(?:\.|,|and|but|so|$)/i)
  if (occupationMatch) result.occupation = occupationMatch[1].trim().slice(0, 50)
  if (/retire[d]|retirement/i.test(t)) result.occupation = 'retired'

  // Referral source
  if (/friend\s*(?:told|recommended|referred|suggested)/i.test(t)) result.referralSource = 'friend_referral'
  else if (/family\s*(?:member|told|recommended)/i.test(t)) result.referralSource = 'family_referral'
  else if (/(?:google|searched|looked\s*up|found\s*(?:you|online))/i.test(t)) result.referralSource = 'google_search'
  else if (/youtube|video|watched/i.test(t)) result.referralSource = 'youtube'
  else if (/facebook|instagram|social\s*media|saw\s*(?:your|the)\s*(?:ad|post)/i.test(t)) result.referralSource = 'social_media'
  else if (/yelp|review/i.test(t)) result.referralSource = 'yelp_reviews'
  else if (/(?:my|the)\s*(?:doctor|dentist|hygienist)\s*(?:sent|referred|told|recommended)/i.test(t)) result.referralSource = 'professional_referral'

  // Competitors visited
  const compPatterns: [RegExp, string][] = [
    [/ClearChoice|Clear\s*Choice/i, 'ClearChoice'],
    [/Nuvia|Nuevia/i, 'Nuvia'],
    [/Aspen\s*Dental/i, 'Aspen Dental'],
    [/Affordable\s*Dentures/i, 'Affordable Dentures'],
    [/another\s*(?:dentist|doctor|office|practice)/i, 'other_practice'],
    [/Mexico|Tijuana|abroad|overseas/i, 'dental_tourism'],
  ]
  for (const [pattern, name] of compPatterns) {
    if (pattern.test(t)) result.competitorsVisited.push(name)
  }

  // Condition duration
  const durationMatch = t.match(/(?:for|about|around|over)\s+(\d+)\s*(year|month|week)s?/i) ||
                         t.match(/(?:since|for)\s+(?:a\s*)?(long\s*time|years|forever)/i)
  if (durationMatch) result.conditionDuration = durationMatch[0].trim()

  // Lifestyle impact
  const impactPatterns: [RegExp, string][] = [
    [/can'?t\s*(?:eat|chew|bite)/i, 'eating_difficulty'],
    [/don'?t\s*smile|hide\s*(?:my\s*)?(?:teeth|smile|mouth)/i, 'social_avoidance'],
    [/embarrass/i, 'social_embarrassment'],
    [/(?:affects?|impacts?|hurts?)\s*(?:my\s*)?(?:job|work|career)/i, 'career_impact'],
    [/pain|discomfort|hurts/i, 'chronic_pain'],
    [/(?:can'?t|afraid\s*to)\s*(?:eat|go\s*out|date|socialize)/i, 'social_isolation'],
    [/self.?(?:conscious|esteem|confidence)/i, 'self_esteem'],
    [/relationship|dating|partner/i, 'relationship_impact'],
  ]
  for (const [pattern, impact] of impactPatterns) {
    if (pattern.test(t)) result.lifestyleImpact.push(impact)
  }

  // Family context
  if (/(?:my|the)\s*(?:wife|husband|spouse|partner)\s*(?:wants|says|thinks)/i.test(t)) result.familyContext = 'spouse_involved'
  else if (/(?:my\s*)?(?:kids?|children|daughter|son)/i.test(t)) result.familyContext = 'children_involved'
  else if (/(?:my\s*)?(?:mom|dad|mother|father|parent)/i.test(t)) result.familyContext = 'parent_involved'

  // Decision makers
  const dmPatterns: [RegExp, string][] = [
    [/(?:my\s*)?(?:wife|husband|spouse|partner)/i, 'spouse'],
    [/(?:my\s*)?(?:daughter|son|kids?|children)/i, 'children'],
    [/(?:my\s*)?(?:doctor|dentist|physician)/i, 'doctor'],
    [/(?:my\s*)?(?:mom|dad|mother|father|parent)/i, 'parent'],
  ]
  for (const [pattern, dm] of dmPatterns) {
    if (pattern.test(t)) result.decisionMakers.push(dm)
  }

  // Previous dental work
  const workPatterns: [RegExp, string][] = [
    [/had\s*implants?/i, 'previous_implants'],
    [/(?:had|have)\s*(?:a\s*)?(?:crown|bridge)/i, 'crowns_bridges'],
    [/root\s*canal/i, 'root_canal'],
    [/extraction|pulled|removed\s*(?:my\s*)?teeth/i, 'extractions'],
    [/braces|orthodont/i, 'orthodontics'],
    [/veneers?/i, 'veneers'],
    [/bone\s*graft/i, 'bone_graft'],
    [/sinus\s*lift/i, 'sinus_lift'],
  ]
  for (const [pattern, work] of workPatterns) {
    if (pattern.test(t)) result.previousDentalWork.push(work)
  }

  // ── CONCERNS & TREATMENT INTEREST ──────────────────────────
  const concernPatterns: [RegExp, string][] = [
    [/missing\s*teeth/i, 'Missing teeth'],
    [/pain|hurts|hurt|aching/i, 'Dental pain'],
    [/embarrass|confident|confidence|self.?conscious/i, 'Confidence/appearance'],
    [/eating|chewing|bite/i, 'Difficulty eating'],
    [/dentures?/i, 'Current dentures'],
    [/sleep\s*apnea/i, 'Sleep apnea'],
    [/tmj|jaw\s*pain/i, 'TMJ/Jaw issues'],
    [/expensive|cost|afford|price|budget/i, 'Cost concerns'],
    [/scared|nervous|afraid|fear|anxiety/i, 'Dental anxiety'],
    [/bone.?\s*graft/i, 'Bone grafting questions'],
    [/recovery|healing|downtime/i, 'Recovery concerns'],
    [/anesthesia|sedation|put\s*me\s*(to\s*)?sleep/i, 'Sedation interest'],
  ]
  for (const [pattern, label] of concernPatterns) {
    if (pattern.test(t)) result.concerns.push(label)
  }

  const treatmentPatterns: [RegExp, string][] = [
    [/all.?on.?4|all\s*on\s*four/i, 'All-on-4'],
    [/all.?on.?6|all\s*on\s*six/i, 'All-on-6'],
    [/all.?on.?x/i, 'All-on-X'],
    [/single\s*implant/i, 'Single implant'],
    [/full\s*mouth/i, 'Full mouth rehabilitation'],
    [/implant/i, 'Dental implants'],
    [/sleep\s*apnea/i, 'Sleep apnea treatment'],
    [/veneers?/i, 'Veneers'],
    [/crown|bridge/i, 'Crown/Bridge'],
    [/teeth\s*(?:in\s*)?(?:a\s*)?day|same\s*day/i, 'Same-day teeth'],
    [/zygomatic|zygoma/i, 'Zygomatic implants'],
    [/snap.?\s*on|overdenture/i, 'Snap-on dentures'],
  ]
  for (const [pattern, label] of treatmentPatterns) {
    if (pattern.test(t)) result.treatmentInterest.push(label)
  }

  // ── AUTO-TAGS ──────────────────────────────────────────────
  if (result.buyingSignals.length >= 2) result.autoTags.push('ready-now')
  if (result.competitorsVisited.length >= 2) result.autoTags.push('price-shopper')
  if ((result.anxietyLevel || 0) >= 7) result.autoTags.push('anxious-patient')
  if (result.treatmentInterest.some(t => /all.?on|full\s*mouth/i.test(t))) result.autoTags.push('high-value')
  if (result.financingInterest) result.autoTags.push('financing-needed')
  if (result.hasDentalInsurance) result.autoTags.push('insurance-verified')
  if (result.decisionMakers.length > 0) result.autoTags.push('family-influencer')
  if (result.competitorsVisited.length > 0) result.autoTags.push('competitor-visited')
  if (result.urgencyLevel === 'emergency' || result.urgencyLevel === 'urgent') result.autoTags.push('urgent-case')
  if (result.hasDentures) result.autoTags.push('denture-wearer')
  if (result.smoker === true) result.autoTags.push('smoker-risk')
  if (result.referralSource?.includes('referral')) result.autoTags.push('referred')
  if (result.pastDentalTrauma) result.autoTags.push('past-trauma')
  if (result.appointmentBooked) result.autoTags.push('appointment-booked')
  if (result.medicalConditions.length > 0) result.autoTags.push('medical-alert')
  if (result.lifestyleImpact.length >= 3) result.autoTags.push('high-impact-case')

  return result
}

// ════════════════════════════════════════════════════════════════
// SCORING ENGINE — 5 Dimensions, 20 points each = 100 total
// ════════════════════════════════════════════════════════════════

function calculateScoreBreakdown(data: EncounterData, ext: ExtractedIntelligence): ScoreBreakdown {
  // CLINICAL (0-20): How severe is their condition?
  let clinical = 0
  if (ext.dentalCondition) clinical += 5
  if (ext.dentalConditionDetails) clinical += 3
  if (ext.hasDentures) clinical += 4 // Denture wearers = high-value upgrades
  if (ext.treatmentInterest.some(t => /all.?on|full\s*mouth/i.test(t))) clinical += 4
  if (ext.concerns.length >= 3) clinical += 2
  if (ext.medicalConditions.length === 0) clinical += 2 // No contraindications = easier case

  // FINANCIAL (0-20): Can they pay?
  let financial = 0
  if (ext.hasDentalInsurance) financial += 4
  if (ext.insuranceProvider) financial += 2
  if (ext.financingInterest) financial += 3
  if (ext.financingApproved) financial += 5
  if (ext.budgetRange && !ext.budgetRange.includes('price-sensitive')) financial += 3
  if (ext.objections.filter(o => /price|afford/i.test(o)).length === 0) financial += 3

  // ENGAGEMENT (0-20): How engaged are they?
  let engagement = 0
  if (data.channel === 'voice') engagement += 5 // Calling = high intent
  else if (data.channel === 'sms') engagement += 3
  else engagement += 2
  if ((data.durationSeconds || 0) > 300) engagement += 5
  else if ((data.durationSeconds || 0) > 120) engagement += 3
  else if ((data.durationSeconds || 0) > 60) engagement += 2
  if (data.sentiment === 'Positive') engagement += 4
  else if (data.sentiment === 'Neutral') engagement += 2
  const messageCount = (data.transcript.match(/^User:/gim) || []).length
  if (messageCount > 10) engagement += 4
  else if (messageCount > 5) engagement += 2

  // PSYCHOLOGICAL (0-20): Are they ready?
  let psychological = 0
  if ((ext.motivationLevel || 0) >= 7) psychological += 5
  else if ((ext.motivationLevel || 0) >= 5) psychological += 3
  if (ext.buyingSignals.length >= 3) psychological += 4
  else if (ext.buyingSignals.length >= 1) psychological += 2
  if ((ext.anxietyLevel || 5) <= 4) psychological += 3 // Low anxiety = ready
  if (ext.decisionStyle === 'decisive') psychological += 4
  else if (ext.decisionStyle === 'consensus') psychological += 1
  if (ext.objections.length === 0) psychological += 2
  if (ext.objectionsResolved.length > 0) psychological += 2

  // SALES (0-20): How close to conversion?
  let sales = 0
  if (ext.appointmentBooked) sales += 10
  if (ext.urgencyLevel === 'emergency') sales += 5
  else if (ext.urgencyLevel === 'urgent') sales += 4
  else if (ext.urgencyLevel === 'moderate') sales += 2
  if (ext.email) sales += 2
  if (data.callSuccessful) sales += 3

  return {
    clinical: Math.min(20, clinical),
    financial: Math.min(20, financial),
    engagement: Math.min(20, engagement),
    psychological: Math.min(20, psychological),
    sales: Math.min(20, sales),
  }
}

// ════════════════════════════════════════════════════════════════
// QUALIFICATION TIER
// ════════════════════════════════════════════════════════════════

function getQualificationTier(score: number, ext: ExtractedIntelligence): string {
  if (score >= 70 || ext.appointmentBooked) return 'hot'
  if (score >= 50) return 'warm'
  if (score >= 30) return 'cold'
  return 'unqualified'
}

// ════════════════════════════════════════════════════════════════
// AI SUMMARY GENERATION
// ════════════════════════════════════════════════════════════════

function generateAISummary(
  data: EncounterData,
  ext: ExtractedIntelligence,
  score: number,
  qualification: string
): string {
  const parts: string[] = []

  // Name + situation
  const name = [ext.firstName, ext.lastName].filter(Boolean).join(' ') || 'Lead'
  parts.push(`${name} (${qualification.toUpperCase()}, score: ${score}/100)`)

  // Condition
  if (ext.dentalCondition) {
    parts.push(`Condition: ${ext.dentalCondition}${ext.hasDentures ? ' (currently has dentures)' : ''}`)
  }

  // Interest
  if (ext.treatmentInterest.length > 0) {
    parts.push(`Interested in: ${ext.treatmentInterest.slice(0, 3).join(', ')}`)
  }

  // Financial
  if (ext.insuranceProvider) parts.push(`Insurance: ${ext.insuranceProvider}`)
  if (ext.financingInterest) parts.push('Interested in financing')

  // Status
  if (ext.appointmentBooked) {
    parts.push(`✅ Appointment: ${ext.appointmentDetails || 'Booked'}`)
  } else if (ext.buyingSignals.length > 0) {
    parts.push(`Buying signals: ${ext.buyingSignals.slice(0, 2).join(', ')}`)
  }

  // Key concerns
  if (ext.objections.length > 0) {
    const unresolved = ext.objections.filter(o => !ext.objectionsResolved.includes(o))
    if (unresolved.length > 0) parts.push(`Unresolved objections: ${unresolved.join(', ')}`)
  }

  // Competitors
  if (ext.competitorsVisited.length > 0) {
    parts.push(`Visited: ${ext.competitorsVisited.join(', ')}`)
  }

  return parts.join('. ') + '.'
}

// ════════════════════════════════════════════════════════════════
// DATABASE UPDATES
// ════════════════════════════════════════════════════════════════

async function updateLeadProfile(
  supabase: SupabaseClient,
  data: EncounterData,
  ext: ExtractedIntelligence,
  score: number,
  breakdown: ScoreBreakdown,
  qualification: string,
  aiSummary: string
) {
  // Start with engagement fields
  const update: Record<string, unknown> = {
    ai_score: score,
    ai_score_breakdown: breakdown,
    ai_score_updated_at: new Date().toISOString(),
    ai_qualification: qualification,
    ai_summary: aiSummary,
    last_contacted_at: new Date().toISOString(),
  }

  // Identity (only update if currently default)
  if (ext.firstName) {
    const { data: current } = await supabase
      .from('leads').select('first_name').eq('id', data.leadId).single()
    if (current?.first_name === 'Unknown' || current?.first_name?.startsWith('Caller') || !current?.first_name) {
      update.first_name = ext.firstName
      if (ext.lastName) update.last_name = ext.lastName
    }
  }
  if (ext.email) update.email = ext.email

  // Clinical
  if (ext.dentalCondition) update.dental_condition = ext.dentalCondition
  if (ext.dentalConditionDetails) update.dental_condition_details = ext.dentalConditionDetails
  if (ext.currentDentalSituation) update.current_dental_situation = ext.currentDentalSituation
  if (ext.hasDentures !== null) update.has_dentures = ext.hasDentures
  if (ext.medicalConditions.length > 0) update.medical_conditions = ext.medicalConditions
  if (ext.medications.length > 0) update.medications = ext.medications
  if (ext.smoker !== null) update.smoker = ext.smoker

  // Financial
  if (ext.hasDentalInsurance !== null) update.has_dental_insurance = ext.hasDentalInsurance
  if (ext.insuranceProvider) update.insurance_provider = ext.insuranceProvider
  if (ext.insuranceDetails) update.insurance_details = ext.insuranceDetails
  if (ext.budgetRange) update.budget_range = ext.budgetRange
  if (ext.financingInterest) update.financing_interest = ext.financingInterest
  if (ext.financingApproved !== null) update.financing_approved = ext.financingApproved
  if (ext.financingAmount) update.financing_amount = ext.financingAmount
  if (ext.treatmentValue) update.treatment_value = ext.treatmentValue

  // Appointment
  if (ext.consultationType) update.consultation_type = ext.consultationType

  // Background
  if (ext.age) update.age = ext.age
  if (ext.gender) update.gender = ext.gender
  if (ext.city) update.city = ext.city
  if (ext.state) update.state = ext.state
  if (ext.zipCode) update.zip_code = ext.zipCode

  // Status
  if (ext.appointmentBooked) {
    update.status = 'qualified'
    update.qualified_at = new Date().toISOString()
  } else if (data.channel === 'voice' && (data.durationSeconds || 0) > 60) {
    update.status = 'contacted'
  } else if ((data.channel === 'sms' || data.channel === 'email')) {
    const { data: current } = await supabase
      .from('leads').select('status').eq('id', data.leadId).single()
    if (current?.status === 'new') update.status = 'contacted'
  }

  // First contact tracking
  const { data: contactCheck } = await supabase
    .from('leads').select('first_contact_at').eq('id', data.leadId).single()
  if (!contactCheck?.first_contact_at) update.first_contact_at = new Date().toISOString()

  // Personality profile
  const personality: Record<string, unknown> = {}
  if (ext.emotionalState) personality.emotional_state = ext.emotionalState
  if (ext.anxietyLevel) personality.anxiety_level = ext.anxietyLevel
  if (ext.motivationLevel) personality.motivation_level = ext.motivationLevel
  if (ext.decisionStyle) personality.decision_style = ext.decisionStyle
  if (ext.communicationStyle) personality.communication_style = ext.communicationStyle
  if (ext.buyingSignals.length > 0) personality.buying_signals = ext.buyingSignals
  if (ext.objections.length > 0) personality.objections = ext.objections
  if (ext.objectionsResolved.length > 0) personality.objections_resolved = ext.objectionsResolved
  if (Object.keys(personality).length > 0) {
    // Merge with existing
    const { data: existing } = await supabase
      .from('leads').select('personality_profile').eq('id', data.leadId).single()
    update.personality_profile = { ...(existing?.personality_profile || {}), ...personality }
  }

  // Custom fields (merge)
  const customFields: Record<string, unknown> = {}
  if (ext.occupation) customFields.occupation = ext.occupation
  if (ext.referralSource) customFields.referral_source = ext.referralSource
  if (ext.competitorsVisited.length > 0) customFields.competitors_visited = ext.competitorsVisited
  if (ext.conditionDuration) customFields.condition_duration = ext.conditionDuration
  if (ext.lifestyleImpact.length > 0) customFields.lifestyle_impact = ext.lifestyleImpact
  if (ext.familyContext) customFields.family_context = ext.familyContext
  if (ext.previousDentalWork.length > 0) customFields.previous_dental_work = ext.previousDentalWork
  if (ext.decisionMakers.length > 0) customFields.decision_makers = ext.decisionMakers
  if (Object.keys(ext.competitorPrices).length > 0) customFields.competitor_prices = ext.competitorPrices
  if (ext.urgencyLevel) customFields.urgency = ext.urgencyLevel
  if (ext.availability) customFields.availability = ext.availability
  if (ext.concerns.length > 0) customFields.concerns = ext.concerns
  if (ext.treatmentInterest.length > 0) customFields.treatment_interest = ext.treatmentInterest
  if (ext.pastDentalTrauma) customFields.past_dental_trauma = true

  if (Object.keys(customFields).length > 0) {
    const { data: existing } = await supabase
      .from('leads').select('custom_fields').eq('id', data.leadId).single()
    update.custom_fields = { ...(existing?.custom_fields || {}), ...customFields }
  }

  // Tags (merge with existing)
  if (ext.autoTags.length > 0) {
    const { data: existing } = await supabase
      .from('leads').select('tags').eq('id', data.leadId).single()
    update.tags = [...new Set([...(existing?.tags || []), ...ext.autoTags])]
  }

  // Notes
  const channelEmoji = data.channel === 'voice' ? '📞' : data.channel === 'sms' ? '💬' : '📧'
  const noteLines: string[] = []
  noteLines.push(`${channelEmoji} ${data.channel.toUpperCase()} | Score: ${score}/100 (${qualification})`)
  if (data.durationSeconds) noteLines.push(`Duration: ${Math.floor(data.durationSeconds / 60)}m ${data.durationSeconds % 60}s`)
  if (data.summary) noteLines.push(`Summary: ${data.summary}`)
  if (data.sentiment) noteLines.push(`Sentiment: ${data.sentiment}`)
  if (ext.insuranceProvider) noteLines.push(`Insurance: ${ext.insuranceProvider}`)
  if (ext.appointmentBooked) noteLines.push(`✅ Appt: ${ext.appointmentDetails || 'Booked'}`)
  if (ext.dentalCondition) noteLines.push(`Condition: ${ext.dentalCondition}`)
  if (ext.concerns.length) noteLines.push(`Concerns: ${ext.concerns.join(', ')}`)
  if (ext.treatmentInterest.length) noteLines.push(`Interest: ${ext.treatmentInterest.join(', ')}`)
  if (ext.buyingSignals.length) noteLines.push(`Buying signals: ${ext.buyingSignals.join(', ')}`)
  if (ext.objections.length) noteLines.push(`Objections: ${ext.objections.join(', ')}`)
  if (ext.competitorsVisited.length) noteLines.push(`Competitors: ${ext.competitorsVisited.join(', ')}`)
  if (ext.autoTags.length) noteLines.push(`Tags: ${ext.autoTags.join(', ')}`)

  const { data: existingLead } = await supabase
    .from('leads').select('notes').eq('id', data.leadId).single()
  const existingNotes = (existingLead?.notes || '').trim()
  update.notes = (existingNotes + `\n\n--- ${new Date().toLocaleString()} ---\n${noteLines.join('\n')}`).slice(-5000)

  await supabase.from('leads').update(update).eq('id', data.leadId)
}

async function logActivity(
  supabase: SupabaseClient,
  data: EncounterData,
  ext: ExtractedIntelligence,
  score: number,
  qualification: string
) {
  const channelEmoji = data.channel === 'voice' ? '📞' : data.channel === 'sms' ? '💬' : '📧'
  
  const activityType = ext.appointmentBooked
    ? `${data.channel}_appointment_booked`
    : `${data.channel}_encounter`

  const title = ext.appointmentBooked
    ? `${channelEmoji} Appointment Booked via ${data.channel.toUpperCase()}`
    : `${channelEmoji} ${data.channel.toUpperCase()} Conversation`

  const descParts: string[] = []
  if (data.summary) descParts.push(data.summary)
  descParts.push(`Score: ${score}/100 (${qualification})`)
  if (data.sentiment) descParts.push(`Sentiment: ${data.sentiment}`)
  if (data.durationSeconds) descParts.push(`${Math.floor(data.durationSeconds / 60)}m ${data.durationSeconds % 60}s`)

  await supabase.from('lead_activities').insert({
    organization_id: data.orgId,
    lead_id: data.leadId,
    activity_type: activityType,
    title,
    description: descParts.join(' | ').slice(0, 500),
    metadata: {
      channel: data.channel,
      ai_score: score,
      qualification,
      sentiment: data.sentiment,
      appointment_booked: ext.appointmentBooked,
      concerns: ext.concerns,
      treatment_interest: ext.treatmentInterest,
      buying_signals: ext.buyingSignals,
      objections: ext.objections,
      auto_tags: ext.autoTags,
      recording_url: data.recordingUrl || null,
      retell_call_id: data.retellCallId || null,
      duration_seconds: data.durationSeconds || null,
    },
  })
}

async function updateEngagementMetrics(supabase: SupabaseClient, data: EncounterData) {
  if (data.conversationId) {
    await supabase.from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', data.conversationId)
  }
}

async function logAIInteraction(supabase: SupabaseClient, data: EncounterData, score: number, qualification: string) {
  await supabase.from('ai_interactions').insert({
    organization_id: data.orgId,
    lead_id: data.leadId,
    interaction_type: `${data.channel}_encounter`,
    model: data.channel === 'voice' ? 'retell-claude-4.5-sonnet' : 'claude-sonnet-4-20250514',
    output_summary: `${data.channel} encounter: score=${score}, qual=${qualification}`,
    success: true,
    metadata: {
      channel: data.channel,
      ai_score: score,
      qualification,
      duration_seconds: data.durationSeconds || null,
      sentiment: data.sentiment || null,
    },
  })
}

async function logTranscriptAsMessages(supabase: SupabaseClient, data: EncounterData) {
  if (!data.conversationId || !data.transcript) return

  const { count } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', data.conversationId)
    .eq('channel', 'voice')
    .limit(1)

  if (count && count > 0) return // Already logged

  const lines = data.transcript.split('\n').filter(l => l.trim())
  const messages: Record<string, unknown>[] = []

  for (const line of lines) {
    const agentMatch = line.match(/^Agent:\s*(.+)/i)
    const userMatch = line.match(/^User:\s*(.+)/i)
    if (agentMatch) {
      messages.push({
        organization_id: data.orgId, conversation_id: data.conversationId,
        lead_id: data.leadId, direction: 'outbound', channel: 'voice',
        body: agentMatch[1].trim(), sender_type: 'ai', sender_name: 'Adrian (AI)',
        status: 'delivered', ai_generated: true,
        metadata: { retell_call_id: data.retellCallId, type: 'voice_transcript' },
      })
    } else if (userMatch) {
      messages.push({
        organization_id: data.orgId, conversation_id: data.conversationId,
        lead_id: data.leadId, direction: 'inbound', channel: 'voice',
        body: userMatch[1].trim(), sender_type: 'lead', status: 'delivered',
        metadata: { retell_call_id: data.retellCallId, type: 'voice_transcript' },
      })
    }
  }

  // Summary message
  messages.push({
    organization_id: data.orgId, conversation_id: data.conversationId,
    lead_id: data.leadId, direction: 'outbound', channel: 'voice',
    body: [
      `📞 Call Summary${data.durationSeconds ? ` (${Math.floor(data.durationSeconds / 60)}m ${data.durationSeconds % 60}s)` : ''}`,
      data.summary || '',
      data.recordingUrl ? `🔊 Recording: ${data.recordingUrl}` : '',
    ].filter(Boolean).join('\n'),
    sender_type: 'system', sender_name: 'Call Analysis',
    status: 'delivered', ai_generated: true,
    metadata: { retell_call_id: data.retellCallId, type: 'voice_call_summary', recording_url: data.recordingUrl },
  })

  if (messages.length > 0) {
    const { error } = await supabase.from('messages').insert(messages)
    if (error) console.error('[Encounter] Failed to insert messages:', error)
    else console.log(`[Encounter] Logged ${messages.length} voice messages`)
  }
}
