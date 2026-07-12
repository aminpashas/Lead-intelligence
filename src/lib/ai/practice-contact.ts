/**
 * Practice Contact prompt block — real phone/address/hours for AI agents.
 *
 * The setter/closer prompts tell the model to act as the practice's
 * coordinator but never gave it the practice's actual contact details, so
 * when the model wanted to say "call us" it invented template-style text
 * ("Call us anytime: [practice phone]") that was sent to patients verbatim.
 *
 * This resolves the org's real contact facts — primary source is the
 * practice_info content asset (same singleton the send_practice_info tool
 * reads), falling back to the organizations row — and renders them into a
 * system-prompt block that also bans placeholder output outright.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getPracticeInfo } from '@/lib/content/practice-assets'

export type PracticeContact = {
  phone: string | null
  address: string | null
  hours: string | null
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * Resolve the practice's real contact phone, address, and hours.
 * Primary: practice_info asset content {phone, address, city, state, zip, hours}.
 * Fallback (per-field): organizations.phone / organizations.address {street, city, state, zip}.
 */
export async function resolvePracticeContact(
  supabase: SupabaseClient,
  organizationId: string
): Promise<PracticeContact> {
  const info = await getPracticeInfo(supabase, organizationId)
  const c = (info?.content as Record<string, unknown> | undefined) ?? {}

  let phone = str(c.phone) || null
  const cityState = [str(c.city), str(c.state)].filter(Boolean).join(', ')
  let address = [str(c.address), cityState, str(c.zip)].filter(Boolean).join(', ') || null
  const hours = str(c.hours) || null

  if (!phone || !address) {
    const { data: org } = await supabase
      .from('organizations')
      .select('phone, address')
      .eq('id', organizationId)
      .maybeSingle()

    if (!phone) phone = str(org?.phone) || null
    if (!address && org?.address && typeof org.address === 'object') {
      // Live org rows use {street, city, state, postal_code}; older ones {zip}.
      const a = org.address as Record<string, unknown>
      const orgCityState = [str(a.city), str(a.state)].filter(Boolean).join(', ')
      const zip = str(a.zip) || str(a.postal_code)
      address = [str(a.street), orgCityState, zip].filter(Boolean).join(', ') || null
    }
  }

  return { phone, address, hours }
}

/**
 * Render the contact facts as a system-prompt block. Pure so it can be unit
 * tested without a database. The placeholder ban is included even when every
 * fact is known — a fact we don't carry (fax, a doctor's direct line, ...) must
 * still never come out as bracketed template text.
 */
export function formatPracticeContactBlock(contact: PracticeContact): string {
  const facts: string[] = []
  if (contact.phone) facts.push(`Practice phone: ${contact.phone}`)
  if (contact.address) facts.push(`Practice address: ${contact.address}`)
  if (contact.hours) facts.push(`Office hours: ${contact.hours}`)

  const factsSection = facts.length > 0
    ? `${facts.join('\n')}\n\nWhen inviting the patient to call, visit, or check hours, use these EXACT values.`
    : `No practice phone, address, or hours are on file for this practice. Do NOT invent them
and do NOT direct the patient to "call us" with a made-up or placeholder number — invite them
to reply to this conversation instead, or use the send_practice_info tool if available.`

  return `═══ PRACTICE CONTACT (REAL VALUES) ═══

${factsSection}

PLACEHOLDER BAN (STRICT): Your message is sent to the patient EXACTLY as you write it —
nothing fills in template variables afterward. NEVER output bracketed or template
placeholders of any kind: no "[practice phone]", "[address]", "[Name]", "{{phone}}",
"[[practice_phone]]", or anything similar. If a fact is not listed above and you do not
know it, leave it out or offer to have a team member follow up — never write a placeholder
and never invent a value.`
}

/**
 * Convenience: resolve + format in one call for the live agent prompt builders.
 * Always returns a non-empty block (the placeholder ban applies regardless).
 */
export async function buildPracticeContactBlock(
  supabase: SupabaseClient,
  organizationId: string
): Promise<string> {
  const contact = await resolvePracticeContact(supabase, organizationId)
  return formatPracticeContactBlock(contact)
}
