/**
 * Texting-style analyzer — reads how THIS patient actually texts and turns it
 * into concrete mirroring instructions for the agent.
 *
 * The setter used to answer a patient's 2-word "really bad" with a four-sentence
 * paragraph — the single biggest tell that a bot is on the other end. Real
 * texters unconsciously match each other's message length and register
 * ("linguistic style matching"); a short-texter who gets paragraphs feels sold
 * to and ghosts. A talker who gets one-liners feels brushed off.
 *
 * So instead of a vague "mirror their communication style" (which the model
 * ignores), we MEASURE the patient's recent inbound texts — length, emoji,
 * capitalization, punctuation, greetings — and inject a block that tells the
 * agent exactly how short and how casual to be for this specific person.
 *
 * Pure + dependency-free so it's trivially testable and safe to run every turn.
 */

/** The prompt-guard wrapper the newest inbound turn carries (see prompt-guard.ts). */
const USER_WRAPPER = /^<user_message>\n?([\s\S]*?)\n?<\/user_message>$/

/** Strip the <user_message> wrapper if present; otherwise return as-is. */
function unwrap(text: string): string {
  const m = text.match(USER_WRAPPER)
  return (m ? m[1] : text).trim()
}

export type Verbosity = 'terse' | 'brief' | 'conversational' | 'talkative' | 'unknown'

export type TextingStyle = {
  /** How many patient messages we actually measured (the recent window). */
  sampleSize: number
  /** Mean word count across the measured messages. */
  avgWords: number
  verbosity: Verbosity
  usesEmoji: boolean
  /** They open with hi/hey/hello etc. rather than diving straight in. */
  usesGreetings: boolean
  /** They mostly skip capitalization (lowercase texter). */
  lowercase: boolean
  /** They mostly end messages with real sentence punctuation. */
  usesPunctuation: boolean
}

const EMOJI = /\p{Extended_Pictographic}/u
const GREETING = /^(hi|hey|hello|yo|good\s+(morning|afternoon|evening)|hiya|howdy)\b/i

function wordCount(s: string): number {
  const t = s.trim()
  return t ? t.split(/\s+/).length : 0
}

/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ BUSINESS RULE — tune to taste. This is YOUR definition of how chatty  │
 * │ a patient is, measured in average words per text, and it drives how   │
 * │ long the agent's OWN replies are allowed to be. Tighten the terse/    │
 * │ brief cutoffs to push the AI shorter (less bot-like, more ghost-proof │
 * │ with quiet leads); loosen them if your patients write more and short  │
 * │ replies come off curt. Examples in comments are real replies from the │
 * │ screenshot that started this.                                         │
 * └─────────────────────────────────────────────────────────────────────┘
 */
export function classifyVerbosity(avgWords: number): Verbosity {
  if (avgWords <= 3) return 'terse'           // "yes" / "really bad" / "10 on weds"
  if (avgWords <= 8) return 'brief'           // one short sentence
  if (avgWords <= 20) return 'conversational' // a sentence or two
  return 'talkative'                          // multi-sentence, likes to talk
}

/**
 * Classify the patient's inbound messages into a texting style.
 *
 * Weights the RECENT window — people warm up or cool off over a thread, and the
 * last few messages predict the next one best. Pass the whole patient-message
 * list; we take the last `windowSize` non-empty ones.
 */
export function analyzeTextingStyle(patientMessages: string[], windowSize = 6): TextingStyle {
  const recent = patientMessages
    .map(unwrap)
    .filter((m) => m.length > 0)
    .slice(-windowSize)

  if (recent.length === 0) {
    return {
      sampleSize: 0,
      avgWords: 0,
      verbosity: 'unknown',
      usesEmoji: false,
      usesGreetings: false,
      lowercase: false,
      usesPunctuation: false,
    }
  }

  const words = recent.map(wordCount)
  const avgWords = words.reduce((a, b) => a + b, 0) / recent.length

  const usesEmoji = recent.some((m) => EMOJI.test(m))
  const usesGreetings = recent.some((m) => GREETING.test(m))

  // Lowercase texter: of the messages that start with a letter, the majority
  // start lowercase. (Guards against a lone "Ok." skewing the read.)
  const alphaStart = recent.filter((m) => /^[a-zA-Z]/.test(m))
  const lowerStart = alphaStart.filter((m) => /^[a-z]/.test(m)).length
  const lowercase = alphaStart.length > 0 && lowerStart / alphaStart.length >= 0.6

  // Punctuation: at least half of messages end in real sentence punctuation.
  const punctuated = recent.filter((m) => /[.!?]$/.test(m)).length
  const usesPunctuation = punctuated / recent.length >= 0.5

  return {
    sampleSize: recent.length,
    avgWords: Math.round(avgWords * 10) / 10,
    verbosity: classifyVerbosity(avgWords),
    usesEmoji,
    usesGreetings,
    lowercase,
    usesPunctuation,
  }
}

/**
 * Turn the measured style into a prompt block of concrete mirroring rules.
 * Register stays "natural but polished": we match the patient's rhythm and
 * casualness, but never invent typos or slang — correct spelling always, since
 * this is a medical practice.
 */
export function formatTextingStyleBlock(style: TextingStyle): string {
  if (style.verbosity === 'unknown') {
    return `═══ THIS PATIENT'S TEXTING STYLE ═══

No inbound texts to read their style from yet. Open SHORT and low-pressure — one line, one easy question. Write less until you see how much they write, then mirror it.`
  }

  const lengthRule: Record<Exclude<Verbosity, 'unknown'>, string> = {
    terse: `They text in very short bursts (~${style.avgWords} words each). MIRROR THEM HARD — your reply is ONE short line, a few words to a single sentence, and at most one question. NEVER answer a 2-3 word text with a paragraph; that is the fastest way to get ghosted here.`,
    brief: `They keep it short (~${style.avgWords} words). Keep yours to one short sentence, maybe two. One idea per text — no paragraphs.`,
    conversational: `They write a sentence or two (~${style.avgWords} words). Match with 1-2 sentences. Still no walls of text.`,
    talkative: `They write longer, detailed messages (~${style.avgWords} words) — they like to talk. You can be a little warmer and more thorough (2-3 sentences) and ask a follow-up. Match their energy, but never dump info.`,
  }

  const lines = [
    `═══ THIS PATIENT'S TEXTING STYLE (mirror it) ═══`,
    ``,
    `Measured from their last ${style.sampleSize} text${style.sampleSize === 1 ? '' : 's'}:`,
    `- Length: ${lengthRule[style.verbosity]}`,
  ]

  // Register mirroring — match casualness in rhythm + capitalization only.
  if (style.lowercase || !style.usesPunctuation) {
    lines.push(
      `- Register: they text casually (${style.lowercase ? 'lowercase' : 'light punctuation'}). Keep yours relaxed and unfussy — lowercase and a trailing thought are fine. Don't sound formal or scripted. Correct spelling always.`
    )
  } else {
    lines.push(
      `- Register: they write in proper sentences, so stay warm but a touch more polished to match — still not stiff or corporate.`
    )
  }

  if (style.usesEmoji) {
    lines.push(
      `- Emoji: they use emoji, so ONE occasional emoji is fine to match — never more than one, never on every line.`
    )
  } else {
    lines.push(
      `- Emoji: they don't use emoji, so you don't either. No 😊/🎉 decoration — an emoji on every line screams "bot".`
    )
  }

  if (!style.usesGreetings) {
    lines.push(
      `- They skip greetings and get straight to it — so don't re-open with "Hi [Name]!" every message. Just answer.`
    )
  }

  return lines.join('\n')
}
