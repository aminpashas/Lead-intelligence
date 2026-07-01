/**
 * Phone-first discovery-call script.
 *
 * Reps run this talk-track during the positive-intent discovery call that gates
 * every consult booking (see the phone-first booking protocol). A practice can
 * override the default with its own script stored in
 * `booking_settings.discovery_script`; `resolveDiscoveryScript` falls back to
 * {@link DEFAULT_DISCOVERY_SCRIPT} whenever the override is missing/blank.
 *
 * Pure module — safe to import from both client components and API routes.
 */

export const DEFAULT_DISCOVERY_SCRIPT = `Phone-First Discovery Call

1. Warm open (build rapport)
   • "Hi {first_name}, this is {rep} calling from {practice} — is now still a good time for a few minutes?"
   • Confirm you're speaking with the patient and thank them for the interest.

2. Understand the situation (pain points)
   • "Tell me what's going on with your teeth right now — what made you reach out?"
   • "How long has this been bothering you, and how is it affecting daily life (eating, smiling, confidence)?"
   • Listen for and capture the specific pain points below.

3. Motivation & timing
   • "If we could fix this, what would change for you?"
   • "Are you looking to move forward in the next few weeks, or still gathering information?"

4. Budget & financing (set expectations early)
   • "Full-arch implant treatment is a real investment. Do you have a rough budget range in mind so I can point you to the right options?"
   • Record the range on the call. Mention financing exists — do NOT quote a final price on the phone.

5. Social proof
   • Offer to text a short patient testimonial or before/after that matches their case, then mark "testimonial sent".

6. Book the discovery consult (the only path forward)
   • "The next step is a complimentary consult with the doctor so we can look at your specific case."
   • Offer two concrete times. Confirm the appointment and that a card-on-file secures the slot.

Notes to log: pain points, budget range, whether a testimonial was sent, and the outcome.`

/**
 * Return the practice's discovery script, or the built-in default when no
 * usable override is provided. A blank/whitespace-only override is treated as
 * "no override".
 */
export function resolveDiscoveryScript(override?: string | null): string {
  const trimmed = override?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_DISCOVERY_SCRIPT
}
