/**
 * Brand identity for AI prompts.
 *
 * The live agents (setter/closer) and the engagement fallback drafter never
 * knew which DBA the patient should hear, so they improvised — an implant
 * financing email once went out signed with the TMJ center's name. This block
 * pins the resolved per-service-line brand (Settings → Branding) into the
 * system prompt and explicitly forbids the sibling brand names.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Lead } from '@/types/database'
import { getBrandingForOrg } from '@/lib/branding/store'
import {
  resolveBrand,
  resolveBrandServiceLine,
  type ResolvedBrand,
} from '@/lib/branding/resolve-brand'

export type BrandIdentity = ResolvedBrand & {
  /** Sibling brand names the agent must never use with this patient. */
  forbiddenNames: string[]
}

/**
 * Resolve the brand a lead should hear, with an explicit fallback service line
 * for callers that KNOW their vertical (the setter/closer are implant-line
 * agents, so an unsignalled lead there is an implant lead — not the org-wide
 * default brand).
 */
export async function resolveBrandIdentity(
  supabase: SupabaseClient,
  orgId: string,
  ctx: { lead?: Partial<Lead> | null; serviceLine?: string | null; fallbackServiceLine?: string }
): Promise<BrandIdentity> {
  const { branding, orgName } = await getBrandingForOrg(supabase, orgId)
  const serviceLine =
    resolveBrandServiceLine({ serviceLine: ctx.serviceLine, lead: (ctx.lead ?? null) as Lead | null }) ??
    ctx.fallbackServiceLine ??
    null
  const brand = resolveBrand(branding, serviceLine, orgName)
  const forbiddenNames = [
    ...new Set(
      Object.values(branding.brands)
        .map((b) => b.name.trim())
        .filter((n) => n && n.toLowerCase() !== brand.practiceName.toLowerCase())
    ),
  ]
  return { ...brand, forbiddenNames }
}

/** Pure formatter — prompt text for a resolved brand identity. */
export function formatBrandIdentityBlock(identity: BrandIdentity): string {
  const lines = [
    '═══ BRAND IDENTITY (MANDATORY) ═══',
    '',
    `You represent ${identity.practiceName}. That is the ONLY practice/brand name this patient may ever see or hear — in greetings, sign-offs, subject lines, and anywhere you name the practice.`,
    identity.doctorName
      ? `You may mention the doctor by name: ${identity.doctorName}.`
      : 'Do not name a specific doctor.',
  ]
  if (identity.website) lines.push(`Practice website: ${identity.website}`)
  if (identity.forbiddenNames.length > 0) {
    lines.push(
      `NEVER use these sibling brand names with this patient: ${identity.forbiddenNames.join('; ')}. They are separate service lines of the same office — do not mention them, and never combine names (e.g. "${identity.practiceName} — ${identity.forbiddenNames[0]}" is a branding error).`
    )
  }
  lines.push(`Sign emails as the ${identity.practiceName} team — one signature only.`)
  return lines.join('\n')
}

/**
 * Convenience: load + resolve + format in one call for agent prompt assembly.
 * Returns '' on any load failure so a branding hiccup never blocks a reply.
 */
export async function buildBrandIdentityBlock(
  supabase: SupabaseClient,
  orgId: string,
  ctx: { lead?: Partial<Lead> | null; serviceLine?: string | null; fallbackServiceLine?: string }
): Promise<string> {
  try {
    return formatBrandIdentityBlock(await resolveBrandIdentity(supabase, orgId, ctx))
  } catch {
    return ''
  }
}
