/**
 * Discovery Call Script — the phone-first protocol's conversation guide.
 *
 * Used two ways:
 *  • Rendered as an on-screen guide for human reps in the log-a-call flow.
 *  • Injected into the AI setter's VOICE prompt so an AI discovery call follows
 *    the same arc.
 *
 * A practice can override the default in Settings → Booking protocol
 * (booking_settings.discovery_script). resolveDiscoveryScript() returns the
 * override when present, else the default below.
 */

export const DEFAULT_DISCOVERY_SCRIPT = `DISCOVERY — build value, excitement, and rapport BEFORE talking money or booking.
Works the same on a call or over text: qualify first, quote never.

1) OPEN-ENDED DISCOVERY (let them talk)
   - "Tell me what's been going on with your smile — what made you reach out?"
   - "How is it affecting your day to day?" (eating, confidence, smiling in photos,
     making memories with kids/grandkids)
   - Learn the GOAL: is it the upper, the lower, or both? How many teeth?
   - Learn the TIMELINE: are they looking to handle this soon, or still exploring?
   - Listen. When the patient names the pain themselves, they get invested in a
     solution. Don't rush to pitch.

2) INTRODUCE FULL-ARCH (AOX) AS THE SOLUTION
   - Connect their specific pain points to how full-arch treatment changes lives.
   - Offer to send the doctor's patient testimonial videos so they hear it from
     patients who've been transformed by the procedure.

3) CASUAL CREDIT READ (once there's rapport — never up front)
   - Keep it light and in buckets: "Roughly, would you say your credit is great,
     good, or still rebuilding?" This tailors what you tell them next.
   - NEVER ask for a number, a credit score, or an SSN.

4) SET BUDGET EXPECTATIONS (a range, not a quote — and only now)
   - Only after goal + timeline + a credit read: give a realistic RANGE so they
     understand this is a significant investment — NOT a $3,000 procedure. This
     qualifies serious consultations.
   - Do not quote an exact price or invent a monthly payment; the consult
     determines the specifics.

5) BOOK + RESERVE
   - Once there's genuine value and excitement, book the consultation.
   - The consult is complimentary, but a card is collected to reserve it — a $50
     fee applies only if they miss without notice. Framed after real value is
     built, this reinforces the appointment's importance rather than deterring.`

/** Return the practice's discovery script, falling back to the default. */
export function resolveDiscoveryScript(override?: string | null): string {
  const trimmed = override?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_DISCOVERY_SCRIPT
}

/**
 * Build a compact block to inject into the AI setter's voice prompt. `priceRange`
 * is the practice's configured talking point (booking_settings.consult_price_range_text).
 */
export function buildDiscoveryPromptBlock(params: {
  script?: string | null
  priceRange?: string | null
}): string {
  const script = resolveDiscoveryScript(params.script)
  const price = params.priceRange?.trim()
  return `═══ DISCOVERY GUIDE ═══

${script}${price ? `\n\nPractice price-range talking point (use ONLY after discovery, as a range): ${price}` : ''}`
}
