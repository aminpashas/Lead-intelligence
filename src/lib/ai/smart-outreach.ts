/**
 * Smart Outreach — DISC-Personality-Adapted Message Generation
 *
 * Creates engaging, personalized outbound messages for SMS, email, and voice
 * channels based on the lead's personality type, pipeline stage, financial
 * readiness, and engagement history.
 *
 * Four communication styles based on DISC:
 * - D (Dominant): Direct, results-focused, concise
 * - I (Influential): Stories, social proof, emotional
 * - S (Steady): Reassuring, patient, supportive
 * - C (Conscientious): Data-driven, detailed, logical
 */

import type { Lead, FinancialSignals, FinancialQualificationTier } from '@/types/database'

export type OutreachChannel = 'sms' | 'email' | 'voice'
export type OutreachStage = 'first_contact' | 'education' | 'soft_qualify' | 'financing_offer' | 'objection_handling' | 'close'

export type OutreachContent = {
  sms: string
  email_subject: string
  email_body: string
  voice_talking_points: string[]
}

type PersonalityType = 'D' | 'I' | 'S' | 'C' | null

// ── Outreach Content Generator ─────────────────────────────────

/**
 * Generate personality-adapted outreach content for all channels.
 */
export function generateSmartOutreach(
  lead: Partial<Lead>,
  stage: OutreachStage,
  context?: {
    practiceName?: string
    doctorName?: string
    appointmentDate?: string
    financialTier?: FinancialQualificationTier
  }
): OutreachContent {
  const firstName = lead.first_name || 'there'
  const practice = context?.practiceName || 'our practice'
  const personality = getPersonalityType(lead)
  const tier = context?.financialTier || lead.financial_qualification_tier || 'tier_c'

  // Pick the content generator based on stage
  switch (stage) {
    case 'first_contact':
      return generateFirstContact(firstName, practice, personality)
    case 'education':
      return generateEducation(firstName, practice, personality)
    case 'soft_qualify':
      return generateSoftQualify(firstName, practice, personality, tier, lead)
    case 'financing_offer':
      return generateFinancingOffer(firstName, practice, personality, lead)
    case 'objection_handling':
      return generateObjectionHandling(firstName, practice, personality, lead)
    case 'close':
      return generateClose(firstName, practice, personality, context?.doctorName)
    default:
      return generateFirstContact(firstName, practice, personality)
  }
}

// ── Stage-Specific Generators ──────────────────────────────────

function generateFirstContact(name: string, practice: string, personality: PersonalityType): OutreachContent {
  const styles = {
    D: {
      sms: `Hi ${name} — you reached out about dental implants. Here's the bottom line: permanent teeth in one day, 98% success rate. When can we get you in for a free consultation? Just reply with a day that works.`,
      subject: `${name}, here's exactly what you need to know about dental implants`,
      opener: `I'll get right to the point.`,
      points: [
        'Get your results fast — summarize the value proposition',
        'Present the free consultation as a no-risk decision',
        'Ask for the appointment directly — they respect directness',
      ],
    },
    I: {
      sms: `Hey ${name}! 😊 Thanks for reaching out! You're going to LOVE hearing about what we do — people literally cry happy tears when they see their new smile for the first time. What's the #1 question on your mind? Just text back!`,
      subject: `${name}, you won't believe what happened to one of our patients...`,
      opener: `I have to share something with you — it's one of my favorite stories.`,
      points: [
        'Lead with a patient success story (emotional, visual)',
        'Make them feel part of a community of happy patients',
        'Ask what excites them most about getting new teeth',
      ],
    },
    S: {
      sms: `Hi ${name}, thank you for reaching out to ${practice}. We know this is a big decision and there's no rush at all. We're here to answer any questions you have, whenever you're ready. What would be most helpful to know first?`,
      subject: `${name}, take your time — we're here whenever you're ready`,
      opener: `First, I want you to know there's absolutely no pressure here.`,
      points: [
        'Emphasize safety, comfort, and the supportive team',
        'Reassure them about sedation and painless procedures',
        'Let them set the pace — no urgency pressure',
      ],
    },
    C: {
      sms: `Hi ${name}, thanks for your inquiry about dental implants at ${practice}. Quick facts: 98.2% success rate, same-day procedure under IV sedation, 20+ year lifespan. Your free consultation includes a $500 3D CT scan. Want the clinical details? Just reply.`,
      subject: `${name}, the clinical data behind All-on-4 implants (98.2% success rate)`,
      opener: `You're probably researching this carefully, so let me give you the data.`,
      points: [
        'Lead with statistics, clinical data, and success rates',
        'Mention certifications, training hours, case volume',
        'Provide a detailed FAQ document or comparison chart',
      ],
    },
  }

  const style = styles[personality || 'I']

  return {
    sms: style.sms,
    email_subject: style.subject,
    email_body: buildEmailBody(name, practice, style.opener, style.subject),
    voice_talking_points: style.points,
  }
}

function generateEducation(name: string, practice: string, personality: PersonalityType): OutreachContent {
  const styles = {
    D: {
      sms: `${name}, here's what matters: All-on-4 = permanent teeth in ONE day. No more denture adhesive, no more slipping. You eat anything you want. Ready to see what this looks like for you? Reply YES for a free consultation.`,
      subject: `The straight facts about permanent teeth, ${name}`,
      opener: `Here are the key facts you need to make your decision.`,
    },
    I: {
      sms: `${name}, just saw another patient leave with the BIGGEST smile today — she couldn't stop looking in the mirror! 😭 That could be you! Want to see some before-and-after photos? I'll send you a few that'll blow your mind.`,
      subject: `${name}, see the transformation that made Patricia cry happy tears`,
      opener: `I wish you could have been here today…`,
    },
    S: {
      sms: `Hi ${name}, just checking in — I wanted to share that the whole procedure is done under sedation, so you sleep through everything. You wake up with new teeth! Most patients say the recovery was easier than they expected. Any questions? I'm here.`,
      subject: `${name}, what the procedure actually feels like (the honest answer)`,
      opener: `I know you might have concerns about the procedure, so let me address them.`,
    },
    C: {
      sms: `${name}, FYI: All-on-4 uses 4 titanium implants per arch at optimized angles for maximum bone contact. Published literature shows 94-98% long-term survival rates across 10+ year studies. Want the peer-reviewed references? Just ask.`,
      subject: `Clinical evidence: All-on-4 implant success data & methodology`,
      opener: `Here's the clinical evidence that backs our approach.`,
    },
  }

  const style = styles[personality || 'I']
  return {
    sms: style.sms,
    email_subject: style.subject,
    email_body: buildEmailBody(name, practice, style.opener, style.subject),
    voice_talking_points: [
      `Adapt tone for ${personality || 'neutral'} personality`,
      'Educate without overwhelming',
      'Listen for financial signals in their responses',
      'Transition naturally toward scheduling',
    ],
  }
}

function generateSoftQualify(
  name: string,
  practice: string,
  personality: PersonalityType,
  tier: FinancialQualificationTier,
  lead: Partial<Lead>
): OutreachContent {
  // Soft qualification varies by tier — never directly ask about income
  const signals = (lead.financial_signals || {}) as Partial<FinancialSignals>

  if (tier === 'tier_a' || tier === 'tier_b') {
    // Already showing financial signals — lean into financing education
    return {
      sms: `${name}, great news — most of our patients get approved for monthly payments, often as low as $199/mo. It's a quick 2-minute check that won't affect your credit. Want me to send you the link? Just text YES 👍`,
      email_subject: `${name}, about the cost of your new smile...`,
      email_body: buildEmailBody(name, practice,
        `I know cost is on your mind, and I want to be transparent. Most patients are pleasantly surprised by how manageable the monthly payments are.`,
        `Financing your new smile`
      ),
      voice_talking_points: [
        'They\'ve shown financial interest — discuss payment options confidently',
        `Detected signals: ${signals.financing_interest || 'medium'} interest, ${signals.price_aware ? 'price-aware' : 'exploring'}`,
        'Present "$X per month" framing — not total cost',
        'Mention soft credit check (won\'t affect score)',
        'Offer to send financing link if they\'re interested',
      ],
    }
  }

  // Tier C/D — soft, educational approach
  return {
    sms: personality === 'D'
      ? `${name}, just so you know — we work with patients at every budget level. Most people are surprised at how affordable it is. Want to chat about what options would work for you?`
      : `Hey ${name}, a lot of people worry about cost, and that's totally normal. The good news is we have tons of flexible options — and your consultation is 100% free. No pressure to commit to anything. Want to hear more?`,
    email_subject: `${name}, let's make this work for your budget`,
    email_body: buildEmailBody(name, practice,
      `I want you to know that cost shouldn't be a barrier. We work with patients at every budget level and have multiple ways to make this affordable.`,
      `Making your new smile affordable`
    ),
    voice_talking_points: [
      'Patient hasn\'t shown strong financial signals yet — DO NOT push financing',
      'Focus on value and outcomes, not price',
      'If they bring up cost, say "most patients find it much more affordable than they expected"',
      'Listen for financial signals and update their profile after the call',
    ],
  }
}

function generateFinancingOffer(
  name: string,
  practice: string,
  personality: PersonalityType,
  lead: Partial<Lead>
): OutreachContent {
  const signals = (lead.financial_signals || {}) as Partial<FinancialSignals>
  const budget = signals.budget_monthly || lead.preferred_monthly_budget

  const monthlyPhrase = budget
    ? `We can likely get you to around $${budget}/mo.`
    : `Most patients qualify for payments as low as $199/mo.`

  return {
    sms: `${name}, ${monthlyPhrase} It takes just 2 minutes to see your options — soft credit check, won't affect your score. No obligation. Ready? I'll send you the link right now!`,
    email_subject: `${name}, your personalized financing options are ready`,
    email_body: buildEmailBody(name, practice,
      `${monthlyPhrase} I wanted to let you know that checking your options is quick, easy, and won't affect your credit score at all.`,
      `Your financing options`
    ),
    voice_talking_points: [
      `Lead is READY for financing — readiness score is above threshold`,
      budget ? `They mentioned a budget of $${budget}/mo — try to match or beat it` : 'Present "as low as" framing',
      'Offer to walk them through the application right now (takes 2 minutes)',
      'Emphasize: soft credit check, no obligation, instant decision',
      'If approved, immediately pivot to scheduling consultation',
    ],
  }
}

function generateObjectionHandling(
  name: string,
  practice: string,
  personality: PersonalityType,
  lead: Partial<Lead>
): OutreachContent {
  const signals = (lead.financial_signals || {}) as Partial<FinancialSignals>
  const barriers = signals.barriers || []

  let sms = ''
  let subject = ''
  let opener = ''

  if (barriers.includes('price_objection') || barriers.includes('affordability_concern')) {
    sms = `${name}, I totally understand cost concerns — it's a big investment. But here's what I always tell patients: dental issues only get MORE expensive over time. And with our flexible options, most patients pay less per month than they spend on coffee. Can we chat about what would work for YOUR budget?`
    subject = `${name}, let's find a way to make this work`
    opener = `I understand your concern about cost. Let me show you some options you might not have considered.`
  } else if (barriers.includes('decision_maker_absent')) {
    sms = `${name}, totally get that — this is a big decision! Would it help if your ${barriers.includes('decision_maker_absent') ? 'partner' : 'family member'} joined a free consultation? There's no obligation, and they can hear directly from the doctor and ask their own questions.`
    subject = `${name}, bring your partner — we'll answer all their questions too`
    opener = `Big decisions are always better made together.`
  } else if (barriers.includes('credit_concern')) {
    sms = `${name}, just so you know — we work with multiple financing partners, and each one has different approval criteria. Even if one says no, another might say yes. Plus, we have in-house options too. Don't count yourself out! 💪`
    subject = `${name}, multiple paths to your new smile (even with credit concerns)`
    opener = `I want to let you in on something most patients don't know.`
  } else {
    sms = `Hey ${name}, I noticed you might have some questions. That's totally normal — this IS a big step! What if I could answer your top 3 questions right now? Just text them to me and I'll get you clear, honest answers. No pressure.`
    subject = `${name}, got questions? I've got answers (no pressure)`
    opener = `I know you've been thinking about this, and I want you to feel 100% confident.`
  }

  return {
    sms,
    email_subject: subject,
    email_body: buildEmailBody(name, practice, opener, subject),
    voice_talking_points: [
      `Key barriers detected: ${barriers.length > 0 ? barriers.join(', ') : 'general hesitation'}`,
      'Lead with empathy — validate their concern before solving it',
      'Never pressure — present alternatives and let them choose',
      personality === 'D' ? 'Be direct about solutions' :
      personality === 'I' ? 'Use stories of patients who overcame similar barriers' :
      personality === 'S' ? 'Reassure repeatedly that there\'s no pressure' :
      'Present data and logical alternatives',
    ],
  }
}

function generateClose(
  name: string,
  practice: string,
  personality: PersonalityType,
  doctorName?: string
): OutreachContent {
  const doctor = doctorName || 'our doctor'

  return {
    sms: personality === 'D'
      ? `${name}, your treatment plan is ready. Dr. ${doctor} reviewed your case and everything looks great. Let's lock in your date — what works this month?`
      : `${name}, I'm really excited for you — your new smile journey is about to begin! Everything is set. When would you like to schedule your procedure? We have some great dates available this month 😊`,
    email_subject: `${name}, your treatment plan is ready — let's pick a date!`,
    email_body: buildEmailBody(name, practice,
      `Great news — your treatment plan has been reviewed by ${doctor} and everything looks excellent. You're ready to go.`,
      `It's time to schedule`
    ),
    voice_talking_points: [
      'This lead is at the closing stage — they need commitment confirmation',
      'Review the treatment plan, answer final questions',
      'Use assumptive close: "Would you prefer morning or afternoon?"',
      'If they hesitate, isolate the objection and address it',
      `Personality: ${personality || 'adapt to their style'}`,
    ],
  }
}

// ── Helpers ────────────────────────────────────────────────────

function getPersonalityType(lead: Partial<Lead>): PersonalityType {
  const profile = lead.personality_profile as Record<string, unknown> | null
  if (!profile?.personality_type) return null
  const pt = (profile.personality_type as string).charAt(0).toUpperCase()
  return ['D', 'I', 'S', 'C'].includes(pt) ? pt as PersonalityType : null
}

function buildEmailBody(name: string, practice: string, opener: string, _subject: string): string {
  return `Hi ${name},

${opener}

I'd love to chat more about this with you. Just reply to this email or call us anytime — we're here for you.

Warm regards,
${practice}`
}
