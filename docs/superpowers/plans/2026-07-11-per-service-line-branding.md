# Per-Service-Line Branding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every patient-facing touch (AI voice calls, booking confirmations, reminders) speak the correct brand name + doctor for the lead's service line, and add a parking/BART block to booking confirmations — all driven by one `resolveBrand()` resolver and editable via a Settings panel + the onboarding interview.

**Architecture:** Branding lives in `organizations.settings.branding` (JSON, same pattern as `settings.legal`/`settings.practice`). A new `src/lib/branding/` module owns the schema, a pure resolver, and a store. Every send-site routes its practice-name through the resolver keyed on the lead/campaign service line. One physical office → shared logistics. No DB migration.

**Tech Stack:** Next.js 16 (App Router) · TypeScript · Supabase · Vitest (`npm test` = `vitest run`; `@/` → `src/`; node env; `describe/it/expect` are globals but existing tests import them from `vitest`).

**Spec:** `docs/superpowers/specs/2026-07-11-per-service-line-branding-design.md`

**Constraints carried from the spec:**
- Prod `MESSAGING_DRY_RUN=1` — sends are staged, not live. Do not lift it in this plan.
- The live voice script is a **Retell-hosted prompt in their dashboard**; the repo only feeds variables. Task 13 delivers the exact dashboard copy — it is applied manually, not deployed.

---

## File Structure

**New — `src/lib/branding/`**
- `schema.ts` — `Brand`, `BrandLogistics`, `Branding` types; `DEFAULT_BRANDING`; `BRAND_SLUGS`; `parseBranding()`; `brandingPatchSchema` (zod for the API).
- `resolve-brand.ts` — `resolveBrandServiceLine()` (explicit-signal-only), `resolveBrand()`, `resolveBrandForContext()`, `type ResolvedBrand`.
- `store.ts` — `getBrandingForOrg()`, `upsertBranding()`.
- `__tests__/schema.test.ts`, `__tests__/resolve-brand.test.ts`.

**New — API + UI**
- `src/app/api/settings/branding/route.ts` — GET/PATCH `settings.branding` (mirrors `settings/legal/route.ts`).
- `src/app/(dashboard)/settings/branding/page.tsx` — Branding settings panel.
- `scripts/seed-branding.ts` — idempotent one-time seed of the SF org's three brands.

**Modified**
- `src/lib/auth/permissions.ts` — add `branding:manage`.
- `src/app/(dashboard)/settings/layout.tsx` — add Branding tab.
- `src/lib/ai/onboarding-agent.ts` — add a `record_branding` tool + write path.
- `src/app/api/booking/[orgId]/book/route.ts` — brand-aware confirmation + logistics.
- `src/app/api/appointments/route.ts` — net-new brand-aware confirmation on staff booking.
- `src/emails/BookingConfirmation.tsx` — brand-aware (Cal.com path).
- `src/lib/voice/outbound-to-lead.ts` — inject `practice_name`/`doctor_name`/`brand_website`.
- `src/app/api/voice/inbound/route.ts` — source `practice_name` from resolver + add `doctor_name`/`brand_website`.
- `src/lib/campaigns/reminders.ts` (caller) — pass resolver-derived practice name into `reminder-templates.ts`.

---

# Phase 1 — Foundation (no behavior change)

### Task 1: Branding schema, types, defaults, parser

**Files:**
- Create: `src/lib/branding/schema.ts`
- Test: `src/lib/branding/__tests__/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/branding/__tests__/schema.test.ts
import { describe, it, expect } from 'vitest'
import { parseBranding, DEFAULT_BRANDING, BRAND_SLUGS } from '@/lib/branding/schema'

describe('parseBranding', () => {
  it('returns the default structure for null/garbage input', () => {
    expect(parseBranding(null)).toEqual(DEFAULT_BRANDING)
    expect(parseBranding('nope')).toEqual(DEFAULT_BRANDING)
    expect(parseBranding(undefined)).toEqual(DEFAULT_BRANDING)
  })

  it('always exposes the three canonical brand slots', () => {
    const b = parseBranding({})
    for (const slug of BRAND_SLUGS) expect(b.brands[slug]).toBeDefined()
  })

  it('overlays entered brand values onto the defaults', () => {
    const b = parseBranding({
      brands: { dion_health: { name: 'Dion Health', doctorName: 'Dr. Amin Samadian', website: 'dionhealth.com' } },
      logistics: { parkingText: 'Sutter-Stockton garage' },
    })
    expect(b.brands.dion_health.name).toBe('Dion Health')
    expect(b.brands.dion_health.doctorName).toBe('Dr. Amin Samadian')
    expect(b.logistics.parkingText).toBe('Sutter-Stockton garage')
    // untouched fields keep defaults
    expect(b.brands.sf_dentistry.name).toBe('')
    expect(b.logistics.addressText).toBe('')
  })

  it('keeps the standard service-line → brand mapping and default brand', () => {
    const b = parseBranding({})
    expect(b.serviceLineToBrand.implants).toBe('dion_health')
    expect(b.serviceLineToBrand.tmj).toBe('tmj_sleep')
    expect(b.serviceLineToBrand.sleep_apnea).toBe('tmj_sleep')
    expect(b.serviceLineToBrand.cosmetic).toBe('sf_dentistry')
    expect(b.defaultBrand).toBe('sf_dentistry')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/branding/__tests__/schema.test.ts`
Expected: FAIL — `Cannot find module '@/lib/branding/schema'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/branding/schema.ts
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
  // Standard structure; the classifier's niche keys map to the medical brands,
  // everything else (incl. the residual) falls to the general brand.
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
  // Always include the canonical slots; also keep any extra slugs an org added.
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/branding/__tests__/schema.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/branding/schema.ts src/lib/branding/__tests__/schema.test.ts
git commit -m "feat(branding): settings.branding schema + parser"
```

---

### Task 2: The resolver (`resolveBrand` + explicit-signal service-line)

**Files:**
- Create: `src/lib/branding/resolve-brand.ts`
- Test: `src/lib/branding/__tests__/resolve-brand.test.ts`

**Why explicit-only:** `classifyLeadServiceLines` treats **implants as the residual default** (a no-signal lead classifies as implants). For branding that is wrong — an unknown lead must fall to SF Dentistry, not Dion Health. So `resolveBrandServiceLine` re-implements matching using the exported `SERVICE_TAGS`/`SERVICE_KEYWORDS` **without** the residual fallback, and returns `null` when there is no explicit signal.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/branding/__tests__/resolve-brand.test.ts
import { describe, it, expect } from 'vitest'
import type { Lead } from '@/types/database'
import { parseBranding } from '@/lib/branding/schema'
import { resolveBrand, resolveBrandServiceLine, resolveBrandForContext } from '@/lib/branding/resolve-brand'

const branding = parseBranding({
  brands: {
    dion_health: { name: 'Dion Health', doctorName: 'Dr. Amin Samadian', website: 'dionhealth.com' },
    tmj_sleep: { name: 'San Francisco Center for TMJ and Sleep Apnea', doctorName: 'Dr. Amin Samadian', website: 'tmjandsleepapneasanfrancisco.com' },
    sf_dentistry: { name: 'SF Dentistry', doctorName: '', website: 'sfdentistry.com' },
  },
  logistics: { addressText: '123 Sutter St', parkingText: 'Garage validated', transitText: 'BART: Montgomery' },
})

const lead = (over: Partial<Lead>): Lead => ({ tags: [], custom_fields: {} , ...over } as unknown as Lead)

describe('resolveBrandServiceLine', () => {
  it('prefers an explicit campaign/context service line', () => {
    expect(resolveBrandServiceLine({ serviceLine: 'tmj' })).toBe('tmj')
  })
  it('detects tmj from the real intake tag src:tmj', () => {
    expect(resolveBrandServiceLine({ lead: lead({ tags: ['src:tmj'] }) })).toBe('tmj')
  })
  it('detects implants only from an explicit signal, never as a residual', () => {
    expect(resolveBrandServiceLine({ lead: lead({ custom_fields: { treatment_interest: 'implant' } }) })).toBe('implants')
    // no signal at all → null (NOT implants)
    expect(resolveBrandServiceLine({ lead: lead({}) })).toBeNull()
  })
  it('prioritises the niche medical lines over implants on multi-match', () => {
    expect(resolveBrandServiceLine({ lead: lead({ tags: ['src:tmj', 'implants'] }) })).toBe('tmj')
  })
})

describe('resolveBrand', () => {
  it('maps implants → Dion Health with the doctor named', () => {
    const r = resolveBrand(branding, 'implants', 'Fallback Org')
    expect(r.practiceName).toBe('Dion Health')
    expect(r.doctorName).toBe('Dr. Amin Samadian')
    expect(r.website).toBe('dionhealth.com')
  })
  it('maps tmj/sleep_apnea → the TMJ & Sleep center', () => {
    expect(resolveBrand(branding, 'tmj', 'x').practiceName).toBe('San Francisco Center for TMJ and Sleep Apnea')
    expect(resolveBrand(branding, 'sleep_apnea', 'x').practiceName).toBe('San Francisco Center for TMJ and Sleep Apnea')
  })
  it('unknown / null service line → SF Dentistry, no doctor named', () => {
    const r = resolveBrand(branding, null, 'x')
    expect(r.practiceName).toBe('SF Dentistry')
    expect(r.doctorName).toBeNull()
  })
  it('falls back to the org name when the brand slot has no name', () => {
    const empty = parseBranding({})
    expect(resolveBrand(empty, 'implants', 'Acme Dental').practiceName).toBe('Acme Dental')
  })
  it('always carries the shared logistics block', () => {
    expect(resolveBrand(branding, 'tmj', 'x').logistics.parkingText).toBe('Garage validated')
  })
})

describe('resolveBrandForContext', () => {
  it('composes lead detection + brand resolution', () => {
    const r = resolveBrandForContext(branding, 'Fallback', { lead: lead({ tags: ['src:tmj'] }) })
    expect(r.practiceName).toBe('San Francisco Center for TMJ and Sleep Apnea')
  })
  it('an unsignalled lead resolves to the default brand', () => {
    expect(resolveBrandForContext(branding, 'Fallback', { lead: lead({}) }).practiceName).toBe('SF Dentistry')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/branding/__tests__/resolve-brand.test.ts`
Expected: FAIL — `Cannot find module '@/lib/branding/resolve-brand'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/branding/resolve-brand.ts
import type { Lead } from '@/types/database'
import { SERVICE_TAGS, SERVICE_KEYWORDS } from '@/lib/leads/service-line'
import type { Branding, BrandLogistics } from '@/lib/branding/schema'

export type ResolvedBrand = {
  practiceName: string
  doctorName: string | null
  website: string | null
  logistics: BrandLogistics
}

// Branding priority when a lead matches more than one line. The niche medical
// brands (their own name + doctor) win over implants; cosmetic/lanap map to the
// general brand anyway so their order only matters relative to each other.
const BRAND_SERVICE_PRIORITY = ['tmj', 'sleep_apnea', 'implants', 'cosmetic', 'lanap'] as const

/** Explicit-signal-only detection — unlike classifyLeadServiceLines this NEVER
 *  falls back to implants. Returns the highest-priority explicitly-signalled
 *  service line, or null. An explicit `serviceLine` (e.g. campaigns.service_line)
 *  short-circuits detection. */
export function resolveBrandServiceLine(input: {
  serviceLine?: string | null
  lead?: Lead | null
}): string | null {
  if (input.serviceLine && input.serviceLine.trim()) return input.serviceLine.trim()
  const lead = input.lead
  if (!lead) return null

  const interest = String((lead.custom_fields?.treatment_interest as string | undefined) ?? '').toLowerCase()
  const tags = (lead.tags ?? []).map((t) => t.toLowerCase())
  const haystack = [lead.utm_campaign, lead.utm_source, lead.campaign_attribution?.campaign_name]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  const matchesExplicit = (key: string): boolean => {
    const explicit = key === 'implants'
      ? interest === 'implant' || interest === 'implants'
      : interest === key
    const tagged = (SERVICE_TAGS[key] ?? []).some((t) => tags.includes(t))
    const keyworded = (SERVICE_KEYWORDS[key] ?? []).some((kw) => haystack.includes(kw))
    return explicit || tagged || keyworded
  }

  for (const key of BRAND_SERVICE_PRIORITY) if (matchesExplicit(key)) return key
  return null
}

/** Resolve the brand for a given (already-decided) service line. Falls back to
 *  orgName when the mapped brand has no name entered yet. */
export function resolveBrand(
  branding: Branding,
  serviceLine: string | null,
  orgName: string
): ResolvedBrand {
  const slug = (serviceLine && branding.serviceLineToBrand[serviceLine]) || branding.defaultBrand
  const brand = branding.brands[slug]
  const name = (brand?.name?.trim()) || (orgName?.trim()) || 'our practice'
  const doctorName = brand?.doctorName?.trim() || null
  const website = brand?.website?.trim() || null
  return { practiceName: name, doctorName, website, logistics: branding.logistics }
}

/** Convenience: detect the service line from context, then resolve the brand. */
export function resolveBrandForContext(
  branding: Branding,
  orgName: string,
  ctx: { serviceLine?: string | null; lead?: Lead | null }
): ResolvedBrand {
  return resolveBrand(branding, resolveBrandServiceLine(ctx), orgName)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/branding/__tests__/resolve-brand.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/branding/resolve-brand.ts src/lib/branding/__tests__/resolve-brand.test.ts
git commit -m "feat(branding): resolveBrand + explicit-signal service-line resolver"
```

---

### Task 3: Branding store (read/merge into `organizations.settings`)

**Files:**
- Create: `src/lib/branding/store.ts`

No new unit test (thin Supabase wrapper; exercised via the API route in Task 4 and integration sites). Mirror the deep-merge mechanics of `src/app/api/settings/legal/route.ts`.

- [ ] **Step 1: Write the implementation**

```ts
// src/lib/branding/store.ts
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
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "src/lib/branding" || echo "branding: no type errors"`
Expected: `branding: no type errors`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/branding/store.ts
git commit -m "feat(branding): org settings store (get + deep-merge upsert)"
```

---

### Task 4: Permission + settings API route

**Files:**
- Modify: `src/lib/auth/permissions.ts`
- Create: `src/app/api/settings/branding/route.ts`

- [ ] **Step 1: Add the `branding:manage` permission**

Open `src/lib/auth/permissions.ts` and find every place `legal_settings:manage` appears:

Run: `grep -n "legal_settings:manage" src/lib/auth/permissions.ts`

Add `branding:manage` **granted to exactly the same roles** as `legal_settings:manage` (owner/admin/agency_admin), replicating that permission's structure verbatim (same role list, same union/enum type entry). If there is a route-permission map used by `canAccessRoute`/`HubNav` in the same file (grep `canAccessRoute` or `'/settings/legal'`), add a `'/settings/branding': 'branding:manage'` entry alongside the legal one.

Run: `grep -n "'/settings/legal'\|canAccessRoute" src/lib/auth/permissions.ts`

- [ ] **Step 2: Verify the permission type compiles**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i permissions || echo "permissions: ok"`
Expected: `permissions: ok`.

- [ ] **Step 3: Create the API route** (clone of `settings/legal/route.ts`, swapping in the branding store + zod)

```ts
// src/app/api/settings/branding/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { hasPermission } from '@/lib/auth/permissions'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { getBrandingForOrg, upsertBranding } from '@/lib/branding/store'
import { brandingPatchSchema } from '@/lib/branding/schema'

export const runtime = 'nodejs'

async function ctx(_request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single()
  if (!profile || !hasPermission(profile.role, 'branding:manage')) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  return { supabase, orgId }
}

export async function GET(request: NextRequest) {
  const c = await ctx(request)
  if ('error' in c) return c.error
  const { branding, orgName } = await getBrandingForOrg(c.supabase, c.orgId)
  return NextResponse.json({ branding, orgName })
}

export async function PATCH(request: NextRequest) {
  const c = await ctx(request)
  if ('error' in c) return c.error
  const body = await request.json().catch(() => ({}))
  const parsed = brandingPatchSchema.safeParse(body?.branding ?? {})
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, { status: 400 })
  }
  const result = await upsertBranding(c.supabase, c.orgId, parsed.data)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 500 })
  return NextResponse.json({ ok: true, branding: result.branding })
}
```

- [ ] **Step 4: Typecheck the route**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "settings/branding" || echo "route: ok"`
Expected: `route: ok`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/permissions.ts src/app/api/settings/branding/route.ts
git commit -m "feat(branding): branding:manage permission + settings API route"
```

---

### Task 5: Branding settings panel + nav tab

**Files:**
- Create: `src/app/(dashboard)/settings/branding/page.tsx`
- Modify: `src/app/(dashboard)/settings/layout.tsx`

Client component mirroring `settings/legal/page.tsx`: `RoleGuard` wrapper, `useEffect` GET to hydrate, `save()` PATCH, `sonner` toasts, `@/components/ui` primitives, `aurea-*` classes.

- [ ] **Step 1: Add the nav tab**

In `src/app/(dashboard)/settings/layout.tsx`, add to the `items` array (after the Legal entry):

```tsx
          { name: 'Branding', href: '/settings/branding' },
```

- [ ] **Step 2: Create the page**

```tsx
// src/app/(dashboard)/settings/branding/page.tsx
'use client'

import { useEffect, useState } from 'react'
import { RoleGuard } from '@/components/auth/role-guard'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { BRAND_SLUGS } from '@/lib/branding/schema'

type BrandForm = { name: string; doctorName: string; website: string }
type LogisticsForm = { addressText: string; parkingText: string; transitText: string }

const BRAND_LABELS: Record<string, string> = {
  dion_health: 'Dion Health (implants)',
  tmj_sleep: 'TMJ & Sleep (tmj / sleep_apnea)',
  sf_dentistry: 'SF Dentistry (general — default)',
}

function BrandingContent() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [brands, setBrands] = useState<Record<string, BrandForm>>({})
  const [logistics, setLogistics] = useState<LogisticsForm>({ addressText: '', parkingText: '', transitText: '' })

  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/settings/branding')
      if (res.ok) {
        const data = await res.json()
        const b = data.branding
        const mapped: Record<string, BrandForm> = {}
        for (const slug of BRAND_SLUGS) {
          const src = b?.brands?.[slug] ?? {}
          mapped[slug] = { name: src.name ?? '', doctorName: src.doctorName ?? '', website: src.website ?? '' }
        }
        setBrands(mapped)
        setLogistics({
          addressText: b?.logistics?.addressText ?? '',
          parkingText: b?.logistics?.parkingText ?? '',
          transitText: b?.logistics?.transitText ?? '',
        })
      }
      setLoading(false)
    })()
  }, [])

  const setBrandField = (slug: string, field: keyof BrandForm, value: string) =>
    setBrands((prev) => ({ ...prev, [slug]: { ...prev[slug], [field]: value } }))

  const save = async () => {
    setSaving(true)
    const res = await fetch('/api/settings/branding', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branding: { brands, logistics } }),
    })
    setSaving(false)
    if (res.ok) toast.success('Branding saved')
    else toast.error('Save failed')
  }

  if (loading) {
    return <div className="flex items-center gap-2 p-8 text-aurea-ink-soft"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
  }

  return (
    <div className="aurea-card space-y-8 p-6">
      <div>
        <p className="aurea-eyebrow">Settings</p>
        <h1 className="aurea-display text-2xl">Branding</h1>
        <p className="text-sm text-aurea-ink-soft">
          Each service line speaks its own brand on calls, texts, and emails. The doctor name is spoken only where set
          (leave blank for general dentistry). Parking &amp; transit is shared across all brands (one office).
        </p>
      </div>

      {BRAND_SLUGS.map((slug) => (
        <div key={slug} className="space-y-3">
          <h2 className="text-sm font-medium text-aurea-ink">{BRAND_LABELS[slug] ?? slug}</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label>Brand name</Label>
              <Input value={brands[slug]?.name ?? ''} onChange={(e) => setBrandField(slug, 'name', e.target.value)} placeholder="e.g. Dion Health" />
            </div>
            <div>
              <Label>Doctor name (optional)</Label>
              <Input value={brands[slug]?.doctorName ?? ''} onChange={(e) => setBrandField(slug, 'doctorName', e.target.value)} placeholder="e.g. Dr. Amin Samadian" />
            </div>
            <div>
              <Label>Website</Label>
              <Input value={brands[slug]?.website ?? ''} onChange={(e) => setBrandField(slug, 'website', e.target.value)} placeholder="e.g. dionhealth.com" />
            </div>
          </div>
          <Separator />
        </div>
      ))}

      <div className="space-y-3">
        <h2 className="text-sm font-medium text-aurea-ink">Location &amp; logistics (shared)</h2>
        <div>
          <Label>Address</Label>
          <Input value={logistics.addressText} onChange={(e) => setLogistics((p) => ({ ...p, addressText: e.target.value }))} placeholder="123 Sutter St, Suite 400, San Francisco, CA 94108" />
        </div>
        <div>
          <Label>Parking</Label>
          <Input value={logistics.parkingText} onChange={(e) => setLogistics((p) => ({ ...p, parkingText: e.target.value }))} placeholder="Validated parking at the Sutter-Stockton garage…" />
        </div>
        <div>
          <Label>Transit / BART</Label>
          <Input value={logistics.transitText} onChange={(e) => setLogistics((p) => ({ ...p, transitText: e.target.value }))} placeholder="BART: exit Montgomery St, 5-min walk up Sutter…" />
        </div>
      </div>

      <Button onClick={save} disabled={saving}>
        {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…</> : 'Save branding'}
      </Button>
    </div>
  )
}

export default function BrandingSettingsPage() {
  return (
    <RoleGuard requiredPermission="branding:manage">
      <BrandingContent />
    </RoleGuard>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "settings/branding" || echo "page: ok"`
Expected: `page: ok`. (If `@/components/ui/separator` or a prop differs, align with the exact imports used in `settings/legal/page.tsx`.)

- [ ] **Step 4: Manual smoke (browser)**

Start the dev server via the preview tool (`npm run dev` is port 3001) and visit `/settings/branding`. Confirm the three brand sections + logistics render, Save toasts success, and a reload re-hydrates the saved values. Capture a screenshot.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/settings/branding/page.tsx" "src/app/(dashboard)/settings/layout.tsx"
git commit -m "feat(branding): settings panel + nav tab"
```

---

### Task 6: Onboarding interview captures branding

**Files:**
- Modify: `src/lib/ai/onboarding-agent.ts`

The interview should collect brand facts and write them to the **same** `settings.branding` (form stays source of truth). Add a second tool `record_branding` that calls `upsertBranding`. The org id + supabase client are already in scope of `runOnboardingInterview` (it constructs `mergeProfileAnswers(supabase, orgId, …)`).

- [ ] **Step 1: Add the tool definition** (next to `RECORD_TOOL`)

```ts
// src/lib/ai/onboarding-agent.ts — add below RECORD_TOOL
const RECORD_BRANDING_TOOL: Anthropic.Messages.Tool = {
  name: 'record_branding',
  description:
    'Save how this practice is branded to patients. Use when the user names a brand/DBA, a doctor to name on calls, a website, or the office address/parking/transit. brands is keyed by slug: dion_health (implants), tmj_sleep (TMJ & sleep), sf_dentistry (general — the default). Set doctorName only where the practice wants the provider named (leave empty for general dentistry). logistics (address/parking/transit) is shared across all brands.',
  input_schema: {
    type: 'object' as const,
    properties: {
      brands: {
        type: 'object',
        description: 'Per-brand-slug partial, e.g. {"dion_health": {"name": "Dion Health", "doctorName": "Dr. Amin Samadian", "website": "dionhealth.com"}}',
      },
      logistics: {
        type: 'object',
        description: 'Shared office logistics: {"addressText": "...", "parkingText": "...", "transitText": "..."}',
      },
    },
  },
}
```

- [ ] **Step 2: Register the tool and handle its calls**

In `runOnboardingInterview`, add `RECORD_BRANDING_TOOL` to the `tools` array passed to the Anthropic client, and in the tool-dispatch loop (where `record_profile_answers` → `mergeProfileAnswers` is handled) add a branch:

```ts
// inside the tool_use handling switch/if-chain, alongside record_profile_answers:
import { upsertBranding } from '@/lib/branding/store'
import { brandingPatchSchema } from '@/lib/branding/schema'
// ...
if (toolUse.name === 'record_branding') {
  const parsed = brandingPatchSchema.safeParse(toolUse.input)
  if (!parsed.success) {
    toolResultContent = `Rejected: ${parsed.error.issues.map((i) => i.message).join('; ')}`
  } else {
    const res = await upsertBranding(supabase, orgId, parsed.data)
    toolResultContent = 'error' in res ? `Could not save branding: ${res.error}` : 'Branding saved.'
  }
}
```

(Match the exact variable names used by the existing loop — `toolUse`, the tool_result string variable, `supabase`, `orgId`. Read lines 107–222 first and mirror the `record_profile_answers` branch precisely.)

- [ ] **Step 3: Nudge the interviewer to ask** — extend the system prompt (`buildSystemPrompt`, in the RULES block) with one line:

```ts
    '- Also capture BRANDING when it comes up: the brand/DBA name patients should hear per service line (implants → Dion Health; TMJ/sleep → the TMJ & Sleep center; general → SF Dentistry), whether to name the doctor, each brand\'s website, and the office address/parking/transit. Record it with record_branding. Never invent or paraphrase a brand name — save it exactly as given.',
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "onboarding-agent" || echo "onboarding: ok"`
Expected: `onboarding: ok`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/onboarding-agent.ts
git commit -m "feat(branding): onboarding interview records branding to settings.branding"
```

---

### Task 7: Seed the SF org's three brands (idempotent, optional convenience)

**Files:**
- Create: `scripts/seed-branding.ts`

The exact brand strings are known; seed them once so the target practice works without manual typing. Writes only `organizations.settings.branding` (org config; the messaging hard-stop is irrelevant to config).

- [ ] **Step 1: Write the script** (mirror an existing `scripts/*.ts` for the service-client bootstrap — e.g. `scripts/seed-demo-contract.ts` if present; otherwise use `createServiceClient`)

```ts
// scripts/seed-branding.ts
// Usage: npx tsx scripts/seed-branding.ts
import { createClient } from '@supabase/supabase-js'
import { upsertBranding } from '@/lib/branding/store'

const SF_ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c'

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  const res = await upsertBranding(supabase as never, SF_ORG_ID, {
    brands: {
      dion_health: { name: 'Dion Health', doctorName: 'Dr. Amin Samadian', website: 'dionhealth.com' },
      tmj_sleep: { name: 'San Francisco Center for TMJ and Sleep Apnea', doctorName: 'Dr. Amin Samadian', website: 'tmjandsleepapneasanfrancisco.com' },
      sf_dentistry: { name: 'SF Dentistry', doctorName: '', website: 'sfdentistry.com' },
    },
    // logistics left for the practice to fill in Settings (address/parking/BART).
  })
  console.log('seed-branding:', res)
}

main().catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: Verify against the local/staging DB, not prod first**

Run (dry check that it typechecks; do NOT run against prod without confirming env): `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "seed-branding" || echo "seed: ok"`
Expected: `seed: ok`. Running the seed against prod is a deliberate, separate step (confirm `SUPABASE_SERVICE_ROLE_KEY` points where intended).

- [ ] **Step 3: Commit**

```bash
git add scripts/seed-branding.ts
git commit -m "chore(branding): idempotent seed of SF org brands"
```

---

# Phase 2 — Booking confirmation (brand-aware + logistics)

### Task 8: Public booking confirmation — brand + parking/BART

**Files:**
- Modify: `src/app/api/booking/[orgId]/book/route.ts`

The appointment here is always `type: 'consultation'` with no service line, so resolve the brand **from the lead** (`resolveBrandForContext`). Append a logistics block when present.

- [ ] **Step 1: Load branding + the lead's signals near the existing org fetch** (replace the `orgName` block at lines 151–157)

```ts
  // Get org branding (brand name + doctor + logistics), resolved per the lead.
  const { getBrandingForOrg } = await import('@/lib/branding/store')
  const { resolveBrandForContext } = await import('@/lib/branding/resolve-brand')
  const { branding, orgName: orgDisplayName } = await getBrandingForOrg(supabase, orgId)

  // Signals the brand resolver reads off the lead.
  const { data: brandLead } = await supabase
    .from('leads')
    .select('tags, custom_fields, utm_campaign, utm_source, campaign_attribution')
    .eq('id', leadId)
    .maybeSingle()
  const brand = resolveBrandForContext(branding, orgDisplayName, { lead: (brandLead as never) ?? null })
  const orgName = brand.practiceName
```

(`leadId` is already defined above the appointment insert in this route.)

- [ ] **Step 2: Build a shared logistics string and append it to the SMS**

Just before the confirmation SMS send (line 264), add:

```ts
  const logisticsLine = [brand.logistics.parkingText, brand.logistics.transitText]
    .filter((s) => s && s.trim())
    .join(' ')
```

Change the SMS body to include it:

```ts
    await sendSMS(phone, `Hi ${first_name}! Your consultation at ${orgName} is confirmed for ${dateDisplay} at ${timeDisplay}.${logisticsLine ? ` ${logisticsLine}` : ''} We look forward to seeing you! Reply STOP to opt out.`)
```

- [ ] **Step 3: Add a logistics block to the confirmation email**

In the email `html`, after the detail `<div>` (the block ending at the `${settings.location ? …}` line), insert:

```ts
          ${(brand.logistics.addressText || brand.logistics.parkingText || brand.logistics.transitText) ? `
          <div style="background: #f4f8ff; padding: 16px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0 0 8px; font-weight: 600;">Getting here</p>
            ${brand.logistics.addressText ? `<p style="margin: 4px 0;">${escapeHtml(brand.logistics.addressText)}</p>` : ''}
            ${brand.logistics.parkingText ? `<p style="margin: 4px 0;"><strong>Parking:</strong> ${escapeHtml(brand.logistics.parkingText)}</p>` : ''}
            ${brand.logistics.transitText ? `<p style="margin: 4px 0;"><strong>Transit:</strong> ${escapeHtml(brand.logistics.transitText)}</p>` : ''}
          </div>` : ''}
```

And append to the plain-text `text:` field: `${logisticsLine ? `${logisticsLine} ` : ''}`.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "booking/\[orgId\]/book" || echo "book route: ok"`
Expected: `book route: ok`.

- [ ] **Step 5: Manual verification (dry-run safe)**

With `MESSAGING_DRY_RUN=1` in the dev env, POST a booking for a lead tagged `src:tmj` and one with no tags; confirm (via `preview_logs`/server logs where `sendSMS` logs the dry-run payload) that the TMJ lead's confirmation says "San Francisco Center for TMJ and Sleep Apnea" and the untagged lead says "SF Dentistry", and both include the parking/transit text when logistics are set.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/booking/[orgId]/book/route.ts"
git commit -m "feat(branding): brand-aware public booking confirmation + logistics"
```

---

### Task 9: Staff booking sends a brand-aware confirmation (net-new)

**Files:**
- Modify: `src/app/api/appointments/route.ts`

Today the staff POST sends **no** patient confirmation. Add one, brand-resolved from the lead, gated so it does not fire for a `pending_card` (held) slot. Reuse `sendSMS` (already the send primitive used across the app; it honors `MESSAGING_DRY_RUN`).

- [ ] **Step 1: After the successful insert + before the `return` (i.e. after line 217's card-link block), add the confirmation send**

```ts
  // Patient confirmation (net-new for staff bookings). Skip held/pending_card
  // slots — those aren't confirmed until the card link is completed.
  if (appointment.status === 'scheduled') {
    try {
      const { getBrandingForOrg } = await import('@/lib/branding/store')
      const { resolveBrandForContext } = await import('@/lib/branding/resolve-brand')
      const { branding, orgName } = await getBrandingForOrg(supabase, orgId)

      const { data: confLead } = await supabase
        .from('leads')
        .select('first_name, phone_formatted, tags, custom_fields, utm_campaign, utm_source, campaign_attribution')
        .eq('id', parsed.data.lead_id)
        .maybeSingle()
      const phone = confLead?.phone_formatted ? (decryptField(confLead.phone_formatted as string) || null) : null
      const brand = resolveBrandForContext(branding, orgName, { lead: (confLead as never) ?? null })

      if (phone) {
        const when = new Date(appointment.scheduled_at as string).toLocaleString('en-US', {
          weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
        })
        const logisticsLine = [brand.logistics.parkingText, brand.logistics.transitText]
          .filter((s) => s && s.trim()).join(' ')
        await sendSMS(phone, `Hi ${confLead?.first_name || 'there'}! Your appointment at ${brand.practiceName} is confirmed for ${when}.${logisticsLine ? ` ${logisticsLine}` : ''} Reply STOP to opt out.`)
      }
    } catch (err) {
      await supabase.from('lead_activities').insert({
        organization_id: orgId,
        lead_id: parsed.data.lead_id,
        activity_type: 'notification_failed',
        title: 'Staff booking confirmation SMS failed',
        metadata: { error: err instanceof Error ? err.message : 'unknown', channel: 'sms' },
      })
    }
  }
```

(`appointment` already selects `scheduled_at`? It selects `'*, lead:leads(...)'` per Task-collection item 5, so `scheduled_at` is present. `decryptField` and `sendSMS` are already imported in this route — confirm via grep; if `sendSMS` is not imported, add `import { sendSMS } from '@/lib/messaging/sms'` matching the booking route's import path.)

- [ ] **Step 2: Confirm imports**

Run: `grep -n "sendSMS\|decryptField" src/app/api/appointments/route.ts`
Expected: both resolve (add the `sendSMS` import if missing, using the same specifier as `src/app/api/booking/[orgId]/book/route.ts`).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "api/appointments/route" || echo "appts route: ok"`
Expected: `appts route: ok`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/appointments/route.ts
git commit -m "feat(branding): staff-booked appointments send a brand-aware confirmation"
```

---

### Task 10: Cal.com confirmation email — brand-aware (light)

**Files:**
- Modify: `src/emails/BookingConfirmation.tsx` and its caller `src/app/api/webhooks/cal/route.ts`

The email component renders a `practiceName`-ish label off the org today. Thread a resolved brand name in from the webhook (resolve from the lead if the webhook has one; else org default).

- [ ] **Step 1: Add an optional `practiceName` prop** to `BookingConfirmation.tsx` (if not already present) and use it in the header/where-line instead of a hardcoded/org value. Keep the default to the existing behavior when the prop is absent.

- [ ] **Step 2: In `src/app/api/webhooks/cal/route.ts`** (the `BOOKING_CREATED` handler, ~line 186), resolve branding and pass `practiceName`:

```ts
  const { getBrandingForOrg } = await import('@/lib/branding/store')
  const { resolveBrandForContext } = await import('@/lib/branding/resolve-brand')
  const { branding, orgName } = await getBrandingForOrg(supabase, orgId)
  const brand = resolveBrandForContext(branding, orgName, { lead: (leadRow as never) ?? null })
  // …pass practiceName={brand.practiceName} into the BookingConfirmation render.
```

(Use whichever lead variable the handler already loaded; if none, pass `{ serviceLine: null }` so it resolves to the default brand.)

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "BookingConfirmation|webhooks/cal" || echo "cal path: ok"`
Expected: `cal path: ok`.

```bash
git add src/emails/BookingConfirmation.tsx src/app/api/webhooks/cal/route.ts
git commit -m "feat(branding): brand-aware Cal.com booking confirmation email"
```

---

# Phase 3 — Voice

### Task 11: Outbound voice — inject brand vars

**Files:**
- Modify: `src/lib/voice/outbound-to-lead.ts`

Outbound currently sends **no** `practice_name`. Add `practice_name`, `doctor_name`, `brand_website`, resolved from the lead. The function already fetches `lead` and has `params.supabase` + `params.organizationId`.

- [ ] **Step 1: Widen the lead select** (line 71-74) to include the brand signals:

```ts
    .select('id, first_name, last_name, phone, phone_formatted, tags, custom_fields, utm_campaign, utm_source, campaign_attribution')
```

- [ ] **Step 2: Resolve branding before building the dynamic variables** (just before the `retell_llm_dynamic_variables` object, ~line 140):

```ts
    const { getBrandingForOrg } = await import('@/lib/branding/store')
    const { resolveBrandForContext } = await import('@/lib/branding/resolve-brand')
    const { branding, orgName } = await getBrandingForOrg(params.supabase, params.organizationId)
    const brand = resolveBrandForContext(branding, orgName, { lead: (lead as never) })
```

- [ ] **Step 3: Add the three variables** into `retell_llm_dynamic_variables` (alongside `caller_first_name` etc.):

```ts
        practice_name: brand.practiceName,
        doctor_name: brand.doctorName || '',
        brand_website: brand.website || '',
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "outbound-to-lead" || echo "outbound: ok"`
Expected: `outbound: ok`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/voice/outbound-to-lead.ts
git commit -m "feat(branding): outbound voice injects practice_name/doctor_name/website"
```

---

### Task 12: Inbound voice — source brand from the resolver

**Files:**
- Modify: `src/app/api/voice/inbound/route.ts`

Inbound already passes `practice_name = org.name`. Re-source it from the resolver keyed on the matched lead, and add `doctor_name`/`brand_website`. The lead object is in scope where the per-lead `dynamicVariables` is built (line 210+).

- [ ] **Step 1: Widen the lead selects** (both the `phone_hash` lookup at line 156-157 and the legacy fallback at line 172-173) to include brand signals:

```ts
            .select('id, first_name, last_name, email, phone, status, ai_score, notes, source_type, personality_profile, tags, custom_fields, utm_campaign, utm_source, campaign_attribution')
```

- [ ] **Step 2: Resolve branding inside the `if (lead) {` block** (line 210), before assembling `dynamicVariables`:

```ts
          const { getBrandingForOrg } = await import('@/lib/branding/store')
          const { resolveBrandForContext } = await import('@/lib/branding/resolve-brand')
          const { branding, orgName } = await getBrandingForOrg(supabase, orgId)
          const brand = resolveBrandForContext(branding, orgName, { lead: (lead as never) })
```

- [ ] **Step 3: Use the resolved brand** in the `dynamicVariables` object (replace `practice_name: practiceName,` and add two vars):

```ts
            practice_name: brand.practiceName,
            doctor_name: brand.doctorName || '',
            brand_website: brand.website || '',
```

(The pre-lead default `dynamicVariables` at line 73-90 keeps `practice_name: practiceName` and can add `doctor_name: '', brand_website: ''` for the no-lead branch so the shape is stable.)

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "voice/inbound/route" || echo "inbound: ok"`
Expected: `inbound: ok`.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/voice/inbound/route.ts
git commit -m "feat(branding): inbound voice sources practice_name/doctor_name/website from resolver"
```

---

### Task 13: Retell dashboard prompt copy (manual deliverable)

**Files:**
- Create: `docs/superpowers/specs/retell-branding-prompt-edit.md`

The live agent's words live in the Retell dashboard, not the repo. Produce the exact edit so the agent uses the new variables. This is applied by hand in Retell; no deploy.

- [ ] **Step 1: Write the handoff doc**

```markdown
# Retell hosted-prompt edit — brand-aware greeting

The repo now sends these dynamic variables on BOTH inbound and outbound calls:
`{{practice_name}}`, `{{doctor_name}}`, `{{brand_website}}` (doctor/website may be empty).

Update the hosted agent prompt(s) (agent id `agent_d5891af66aa9f7a83b9f96fc3a` for
inbound; the outbound agent id from `RETELL_OUTBOUND_AGENT_ID`) so the opening line
reads (Retell supports `{{#var}}…{{/var}}` conditionals):

Outbound opener:
> "Hi {{caller_first_name}}, this is the patient coordinator calling from
> {{practice_name}}{{#doctor_name}}, the office of {{doctor_name}}{{/doctor_name}}."

Inbound opener:
> "Thanks for calling {{practice_name}}{{#doctor_name}}, the office of
> {{doctor_name}}{{/doctor_name}}. This is the patient coordinator — how can I help?"

Rules for the agent:
- Name the doctor ONLY when `{{doctor_name}}` is non-empty (general dentistry / SF
  Dentistry leaves it blank — never invent a provider name).
- Keep the existing "never share a personal name" behavior for the coordinator itself.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/retell-branding-prompt-edit.md
git commit -m "docs(branding): Retell dashboard prompt edit for brand-aware voice"
```

---

# Phase 4 — Reminders

### Task 14: Appointment reminders use the resolver

**Files:**
- Modify: `src/lib/campaigns/reminders.ts` (the caller that computes `practiceName` and calls the `reminder-templates.ts` generators)

Reminders currently pass `org?.name || 'our office'` as `practiceName`. Route it through the resolver, keyed on the reminder's lead, so a TMJ patient's reminders say the TMJ brand.

- [ ] **Step 1: In `sendAppointmentReminders`** (the per-appointment loop in `reminders.ts`, ~line 92-300), where `practiceName` and `location` are computed, resolve branding per lead:

```ts
  const { getBrandingForOrg } = await import('@/lib/branding/store')
  const { resolveBrandForContext } = await import('@/lib/branding/resolve-brand')
  const { branding, orgName } = await getBrandingForOrg(supabase, orgId)
  // …inside the per-appointment loop, with the loaded lead row (ensure the lead
  // select includes tags, custom_fields, utm_campaign, utm_source, campaign_attribution):
  const brand = resolveBrandForContext(branding, orgName, { lead: (leadRow as never) })
  const practiceName = brand.practiceName
  const location = [brand.logistics.addressText, brand.logistics.parkingText, brand.logistics.transitText]
    .filter((s) => s && s.trim()).join(' — ') || (existingLocation ?? null)
```

Pass this `practiceName`/`location` into `generate72hEmailTemplate` / `generate24hEmailTemplate` / `generate24hSmsTemplate` / `generate1hSmsTemplate` exactly as before (their signatures are unchanged — see collection item 6).

- [ ] **Step 2: Widen the lead select in the reminder query** to include `tags, custom_fields, utm_campaign, utm_source, campaign_attribution` if not already selected.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "campaigns/reminders" || echo "reminders: ok"`
Expected: `reminders: ok`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/campaigns/reminders.ts
git commit -m "feat(branding): appointment reminders use brand resolver"
```

---

## Final verification

- [ ] **Full test suite**

Run: `npm test`
Expected: all pass, including the new `src/lib/branding/__tests__/*`.

- [ ] **Full typecheck (catches what incremental greps miss)**

Run: `npm run build`
Expected: build succeeds. (Per project history, `next build` catches type errors that incremental `tsc` can miss — treat this as the gate before any merge.)

- [ ] **End-to-end brand check (dry-run)**

With `MESSAGING_DRY_RUN=1`: exercise a public booking, a staff booking, an inbound-voice register call, and a reminder for (a) a `src:tmj` lead and (b) an untagged lead. Confirm from logs that (a) speaks/writes "San Francisco Center for TMJ and Sleep Apnea" + names Dr. Samadian, and (b) speaks/writes "SF Dentistry" with no doctor named, and that booking confirmations include the parking/BART block.

---

## Self-review notes (author)

- **Spec coverage:** brand model (Tasks 1–3, 7), settings form (Task 5), onboarding capture (Task 6), booking confirmation + logistics + staff-gap (Tasks 8–10), voice inbound/outbound + Retell copy (Tasks 11–13), reminders (Task 14). All spec sections mapped.
- **Type consistency:** `resolveBrand`/`resolveBrandForContext`/`resolveBrandServiceLine`, `getBrandingForOrg`/`upsertBranding`, `parseBranding`/`brandingPatchSchema`, `BRAND_SLUGS`, `ResolvedBrand` used identically across tasks.
- **Known verify-at-implementation points (grep first, then mirror):** exact permission-map shape in `permissions.ts` (Task 4); the tool-loop variable names in `onboarding-agent.ts` (Task 6); `sendSMS` import specifier in `appointments/route.ts` (Task 9); the `BookingConfirmation.tsx` prop names and the lead variable in the Cal webhook (Task 10); the reminder loop's existing lead select + `location` variable name (Task 14).
