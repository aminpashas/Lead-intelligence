import type { SupabaseClient } from '@supabase/supabase-js'
import { parseBranding, type Branding, type BrandingPatch } from '@/lib/branding/schema'

/** Load an org's parsed branding plus its display name (the resolver fallback). */
export async function getBrandingForOrg(
  supabase: SupabaseClient,
  orgId: string
): Promise<{ branding: Branding; orgName: string }> {
  const { data } = await supabase
    .from('organizations')
    .select('name, settings')
    .eq('id', orgId)
    .single()
  const settings = (data?.settings ?? {}) as Record<string, unknown>
  return {
    branding: parseBranding(settings.branding),
    orgName: (data?.name as string | null) ?? '',
  }
}

/** Deep-merge a branding patch into organizations.settings.branding, preserving
 *  sibling settings keys (legal/contracts/practice) and un-patched branding
 *  sub-objects. Returns the merged branding. */
export async function upsertBranding(
  supabase: SupabaseClient,
  orgId: string,
  patch: BrandingPatch
): Promise<{ branding: Branding } | { error: string }> {
  const { data: current } = await supabase
    .from('organizations')
    .select('settings')
    .eq('id', orgId)
    .single()
  const settings = (current?.settings ?? {}) as Record<string, unknown>
  const existing = parseBranding(settings.branding)

  const mergedBrands = { ...existing.brands }
  for (const [slug, b] of Object.entries(patch.brands ?? {})) {
    mergedBrands[slug] = {
      name: b?.name ?? mergedBrands[slug]?.name ?? '',
      doctorName: b?.doctorName ?? mergedBrands[slug]?.doctorName ?? '',
      website: b?.website ?? mergedBrands[slug]?.website ?? '',
    }
  }

  const mergedBranding: Branding = {
    brands: mergedBrands,
    serviceLineToBrand: { ...existing.serviceLineToBrand, ...(patch.serviceLineToBrand ?? {}) },
    defaultBrand: patch.defaultBrand ?? existing.defaultBrand,
    logistics: { ...existing.logistics, ...(patch.logistics ?? {}) },
  }

  const { error } = await supabase
    .from('organizations')
    .update({ settings: { ...settings, branding: mergedBranding } })
    .eq('id', orgId)
  if (error) return { error: error.message }
  return { branding: mergedBranding }
}
