import { z } from 'zod'

export type Brand = {
  name: string
  doctorName: string
  website: string
}

export type BrandLogistics = {
  addressText: string
  parkingText: string
  transitText: string
}

export type Branding = {
  /** Keyed by brand slug (BRAND_SLUGS). */
  brands: Record<string, Brand>
  /** service-line key (see src/lib/leads/service-line.ts) → brand slug. */
  serviceLineToBrand: Record<string, string>
  /** brand slug used when no service line resolves. */
  defaultBrand: string
  /** Shared across all brands — one physical office. */
  logistics: BrandLogistics
}

export const BRAND_SLUGS = ['dion_health', 'tmj_sleep', 'sf_dentistry'] as const

const emptyBrand = (): Brand => ({ name: '', doctorName: '', website: '' })

export const DEFAULT_BRANDING: Branding = {
  brands: {
    dion_health: emptyBrand(),
    tmj_sleep: emptyBrand(),
    sf_dentistry: emptyBrand(),
  },
  serviceLineToBrand: {
    implants: 'dion_health',
    tmj: 'tmj_sleep',
    sleep_apnea: 'tmj_sleep',
    cosmetic: 'sf_dentistry',
    lanap: 'sf_dentistry',
  },
  defaultBrand: 'sf_dentistry',
  logistics: { addressText: '', parkingText: '', transitText: '' },
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function parseBrand(raw: unknown, fallback: Brand): Brand {
  if (!raw || typeof raw !== 'object') return { ...fallback }
  const r = raw as Record<string, unknown>
  return {
    name: str(r.name) || fallback.name,
    doctorName: str(r.doctorName) || fallback.doctorName,
    website: str(r.website) || fallback.website,
  }
}

/** Forgiving parser: overlays stored config onto DEFAULT_BRANDING so the three
 *  brand slots + the standard mapping always exist, even for a partial blob. */
export function parseBranding(raw: unknown): Branding {
  if (!raw || typeof raw !== 'object') return structuredClone(DEFAULT_BRANDING)
  const r = raw as Record<string, unknown>

  const rawBrands = (r.brands && typeof r.brands === 'object' ? r.brands : {}) as Record<string, unknown>
  const brands: Record<string, Brand> = {}
  const slugs = new Set<string>([...BRAND_SLUGS, ...Object.keys(rawBrands)])
  for (const slug of slugs) {
    brands[slug] = parseBrand(rawBrands[slug], DEFAULT_BRANDING.brands[slug] ?? emptyBrand())
  }

  const rawMap = (r.serviceLineToBrand && typeof r.serviceLineToBrand === 'object'
    ? r.serviceLineToBrand
    : {}) as Record<string, unknown>
  const serviceLineToBrand: Record<string, string> = { ...DEFAULT_BRANDING.serviceLineToBrand }
  for (const [k, v] of Object.entries(rawMap)) if (typeof v === 'string') serviceLineToBrand[k] = v

  const rawLog = (r.logistics && typeof r.logistics === 'object' ? r.logistics : {}) as Record<string, unknown>
  const logistics: BrandLogistics = {
    addressText: str(rawLog.addressText),
    parkingText: str(rawLog.parkingText),
    transitText: str(rawLog.transitText),
  }

  return {
    brands,
    serviceLineToBrand,
    defaultBrand: str(r.defaultBrand) || DEFAULT_BRANDING.defaultBrand,
    logistics,
  }
}

/** Zod schema for the PATCH body — every field optional (partial patch). */
export const brandingPatchSchema = z.object({
  brands: z.record(z.string(), z.object({
    name: z.string().max(200).optional(),
    doctorName: z.string().max(200).optional(),
    website: z.string().max(300).optional(),
  })).optional(),
  serviceLineToBrand: z.record(z.string(), z.string()).optional(),
  defaultBrand: z.string().max(60).optional(),
  logistics: z.object({
    addressText: z.string().max(500).optional(),
    parkingText: z.string().max(1000).optional(),
    transitText: z.string().max(1000).optional(),
  }).optional(),
})

export type BrandingPatch = z.infer<typeof brandingPatchSchema>
