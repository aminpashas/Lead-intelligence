import type { SupabaseClient } from '@supabase/supabase-js'
import { configuredBrandSlugs, parseBranding, type Branding, type BrandingPatch } from '@/lib/branding/schema'

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
  patch: BrandingPatch,
  options: {
    /** Plan quota on configured (named) brands; null/undefined = unlimited. */
    maxBrands?: number | null
    /** Error message when the quota would be exceeded. */
    limitMessage?: string
  } = {}
): Promise<{ branding: Branding } | { error: string; limitExceeded?: true }> {
  // Load current settings first. If the read fails, bail — otherwise `existing`
  // would collapse to DEFAULT_BRANDING and the UPDATE below would silently
  // clobber any real stored branding with defaults-plus-patch.
  const { data: current, error: readError } = await supabase
    .from('organizations')
    .select('settings')
    .eq('id', orgId)
    .single()
  if (readError || !current) return { error: readError?.message ?? 'Organization not found' }
  const settings = (current.settings ?? {}) as Record<string, unknown>
  const existing = parseBranding(settings.branding)

  const mergedBrands = { ...existing.brands }
  for (const [slug, b] of Object.entries(patch.brands ?? {})) {
    mergedBrands[slug] = {
      name: b?.name ?? mergedBrands[slug]?.name ?? '',
      doctorName: b?.doctorName ?? mergedBrands[slug]?.doctorName ?? '',
      website: b?.website ?? mergedBrands[slug]?.website ?? '',
      logoUrl: b?.logoUrl ?? mergedBrands[slug]?.logoUrl ?? '',
    }
  }
  for (const slug of patch.removeBrands ?? []) delete mergedBrands[slug]

  // Service-line mappings pointing at a removed brand fall back to defaultBrand
  // at resolve time already (resolveBrand handles a missing slug), but keep the
  // stored map clean so the settings UI doesn't show dangling mappings.
  const removed = new Set(patch.removeBrands ?? [])
  const mergedMap: Record<string, string> = {}
  for (const [line, slug] of Object.entries({ ...existing.serviceLineToBrand, ...(patch.serviceLineToBrand ?? {}) })) {
    if (!removed.has(slug)) mergedMap[line] = slug
  }

  let defaultBrand = patch.defaultBrand ?? existing.defaultBrand
  if (removed.has(defaultBrand)) {
    defaultBrand = Object.keys(mergedBrands).find((s) => mergedBrands[s].name.trim()) ?? Object.keys(mergedBrands)[0] ?? ''
  }

  const mergedBranding: Branding = {
    brands: mergedBrands,
    serviceLineToBrand: mergedMap,
    defaultBrand,
    logistics: { ...existing.logistics, ...(patch.logistics ?? {}) },
  }

  // Plan quota: only a patch that *grows* the configured-brand count past the
  // cap is rejected. Edits, removals, and saves by an org already over quota
  // (grandfathered before a downgrade) still succeed — they just can't add more.
  const max = options.maxBrands
  if (max !== null && max !== undefined) {
    const before = configuredBrandSlugs(existing).length
    const after = configuredBrandSlugs(mergedBranding).length
    if (after > max && after > before) {
      return {
        error: options.limitMessage ?? `Your plan allows ${max} brand${max === 1 ? '' : 's'}.`,
        limitExceeded: true,
      }
    }
  }

  const { data: updated, error } = await supabase
    .from('organizations')
    .update({ settings: { ...settings, branding: mergedBranding } })
    .eq('id', orgId)
    .select('id')
  if (error) return { error: error.message }
  if (!updated || updated.length === 0) return { error: 'Organization not found' }
  return { branding: mergedBranding }
}
