'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { RoleGuard } from '@/components/auth/role-guard'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import { ImagePlus, Loader2, Plus, Trash2 } from 'lucide-react'
import { slugifyBrandName } from '@/lib/branding/schema'

type BrandForm = { name: string; doctorName: string; website: string; logoUrl: string }
type LogisticsForm = {
  addressText: string
  drivingText: string
  parkingText: string
  transitText: string
  whatToExpectText: string
}
type PlanInfo = { tierId: 'basic' | 'growth' | 'full'; maxBrands: number | null; brandsUsed: number }

const EMPTY_BRAND: BrandForm = { name: '', doctorName: '', website: '', logoUrl: '' }
const EMPTY_LOGISTICS: LogisticsForm = {
  addressText: '',
  drivingText: '',
  parkingText: '',
  transitText: '',
  whatToExpectText: '',
}

const TIER_NAME: Record<PlanInfo['tierId'], string> = { basic: 'Basic', growth: 'Growth', full: 'Full' }

const hasContent = (b: BrandForm) => Object.values(b).some((v) => v.trim().length > 0)

function SettingsCard({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="aurea-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-aurea-border px-5 py-4">
        <h2 className="aurea-display text-[18px] text-aurea-ink">{title}</h2>
        {action}
      </div>
      <div className="px-5 py-5">{children}</div>
    </section>
  )
}

function LogoField({
  slug,
  value,
  onChange,
}: {
  slug: string
  value: string
  onChange: (url: string) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  const upload = async (file: File) => {
    setUploading(true)
    const form = new FormData()
    form.append('file', file)
    form.append('slug', slug)
    const res = await fetch('/api/settings/branding/logo', { method: 'POST', body: form })
    setUploading(false)
    const data = await res.json().catch(() => ({}))
    if (res.ok && data.url) {
      onChange(data.url)
      toast.success('Logo uploaded — save branding to keep it')
    } else {
      toast.error(data.error ?? 'Logo upload failed')
    }
  }

  return (
    <div>
      <Label className="text-[12px] text-aurea-ink-3">Logo</Label>
      <div className="mt-1 flex items-center gap-3">
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value} alt="Brand logo" className="h-10 w-10 rounded border border-aurea-border object-contain bg-white" />
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded border border-dashed border-aurea-border text-aurea-ink-3">
            <ImagePlus className="h-4 w-4" />
          </div>
        )}
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://… or upload"
          className="flex-1"
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void upload(f)
            e.target.value = ''
          }}
        />
        <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Upload'}
        </Button>
      </div>
    </div>
  )
}

function BrandingSettingsContent() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [brands, setBrands] = useState<Record<string, BrandForm>>({})
  const [brandOrder, setBrandOrder] = useState<string[]>([])
  const [removedSlugs, setRemovedSlugs] = useState<string[]>([])
  const [defaultBrand, setDefaultBrand] = useState('')
  const [logistics, setLogistics] = useState<LogisticsForm>(EMPTY_LOGISTICS)
  const [plan, setPlan] = useState<PlanInfo | null>(null)
  const newCounter = useRef(0)

  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/settings/branding')
      if (res.ok) {
        const data = await res.json()
        const b = data.branding
        const mapped: Record<string, BrandForm> = {}
        for (const [slug, raw] of Object.entries((b?.brands ?? {}) as Record<string, Partial<BrandForm>>)) {
          const form: BrandForm = {
            name: raw?.name ?? '',
            doctorName: raw?.doctorName ?? '',
            website: raw?.website ?? '',
            logoUrl: raw?.logoUrl ?? '',
          }
          if (hasContent(form)) mapped[slug] = form
        }
        setBrands(mapped)
        setBrandOrder(Object.keys(mapped))
        setDefaultBrand(b?.defaultBrand ?? '')
        setLogistics({
          addressText: b?.logistics?.addressText ?? '',
          drivingText: b?.logistics?.drivingText ?? '',
          parkingText: b?.logistics?.parkingText ?? '',
          transitText: b?.logistics?.transitText ?? '',
          whatToExpectText: b?.logistics?.whatToExpectText ?? '',
        })
        if (data.plan) setPlan(data.plan)
      }
      setLoading(false)
    })()
  }, [])

  const namedCount = useMemo(
    () => brandOrder.filter((s) => brands[s]?.name.trim()).length,
    [brandOrder, brands]
  )
  const atLimit = plan?.maxBrands != null && namedCount >= plan.maxBrands

  const setBrandField = (slug: string, field: keyof BrandForm, value: string) =>
    setBrands((prev) => ({ ...prev, [slug]: { ...prev[slug], [field]: value } }))

  const addBrand = () => {
    const slug = `new_brand_${++newCounter.current}`
    setBrands((prev) => ({ ...prev, [slug]: { ...EMPTY_BRAND } }))
    setBrandOrder((prev) => [...prev, slug])
  }

  const removeBrand = (slug: string) => {
    setBrandOrder((prev) => prev.filter((s) => s !== slug))
    setBrands((prev) => {
      const next = { ...prev }
      delete next[slug]
      return next
    })
    if (!slug.startsWith('new_brand_')) setRemovedSlugs((prev) => [...prev, slug])
    if (defaultBrand === slug) setDefaultBrand('')
  }

  const save = async () => {
    // Finalize slugs for locally-added brands from their names.
    const payloadBrands: Record<string, BrandForm> = {}
    const slugFor: Record<string, string> = {}
    for (const slug of brandOrder) {
      const b = brands[slug]
      if (!b || !hasContent(b)) continue
      let finalSlug = slug
      if (slug.startsWith('new_brand_')) {
        const base = slugifyBrandName(b.name) || `brand_${Date.now()}`
        finalSlug = base
        let n = 2
        while (payloadBrands[finalSlug] || (brands[finalSlug] && finalSlug !== slug)) finalSlug = `${base}_${n++}`
      }
      slugFor[slug] = finalSlug
      payloadBrands[finalSlug] = b
    }

    const named = Object.entries(payloadBrands).filter(([, b]) => b.name.trim())
    const resolvedDefault =
      (defaultBrand && slugFor[defaultBrand]) ||
      (payloadBrands[defaultBrand] ? defaultBrand : named[0]?.[0] ?? '')

    setSaving(true)
    const res = await fetch('/api/settings/branding', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        branding: {
          brands: payloadBrands,
          removeBrands: removedSlugs,
          ...(resolvedDefault ? { defaultBrand: resolvedDefault } : {}),
          logistics,
        },
      }),
    })
    setSaving(false)
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      toast.success('Branding saved')
      setRemovedSlugs([])
      // Adopt finalized slugs so subsequent edits patch the stored keys.
      setBrands(payloadBrands)
      setBrandOrder(Object.keys(payloadBrands))
      setDefaultBrand(resolvedDefault)
      if (plan) setPlan({ ...plan, brandsUsed: named.length })
    } else if (data.code === 'tier_limit') {
      toast.error(data.error ?? 'Brand limit reached for your plan')
    } else {
      toast.error(data.error ?? 'Save failed')
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-aurea-ink-3" />
      </div>
    )
  }

  return (
    <div className="animate-in fade-in-0 duration-500 max-w-3xl space-y-6">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="border-b border-aurea-border pb-8">
        <p className="aurea-eyebrow mb-3">Settings</p>
        <h1 className="aurea-display text-[40px] text-aurea-ink sm:text-[52px]">Branding</h1>
        <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-aurea-ink-2">
          Each brand carries its own name, logo, doctor, and website on calls, texts, emails, and campaigns. Address,
          directions &amp; &ldquo;what to expect&rdquo; are shared across all brands (one office) and are attached to
          every booking confirmation to cut no-shows.
        </p>
      </header>

      {/* ── Plan usage ─────────────────────────────────────── */}
      {plan && (
        <div className="flex items-center justify-between rounded-md border border-aurea-border px-4 py-3">
          <p className="text-[13px] text-aurea-ink-2">
            <span className="font-medium text-aurea-ink">{TIER_NAME[plan.tierId]} plan</span>
            {' · '}
            {namedCount} of {plan.maxBrands ?? 'unlimited'} brand{plan.maxBrands === 1 ? '' : 's'} used
          </p>
          {atLimit && (
            <Link href="/settings/billing" className="text-[13px] font-medium text-aurea-ink underline underline-offset-4">
              Upgrade for more brands
            </Link>
          )}
        </div>
      )}

      {/* ── Brands ─────────────────────────────────────────── */}
      {brandOrder.length === 0 && (
        <div className="rounded-md border border-dashed border-aurea-border px-5 py-10 text-center">
          <p className="text-[14px] text-aurea-ink-2">No brands yet. Add your first brand to get started.</p>
        </div>
      )}

      {brandOrder.map((slug) => (
        <SettingsCard
          key={slug}
          title={brands[slug]?.name.trim() || 'New brand'}
          action={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => removeBrand(slug)}
              className="text-aurea-ink-3 hover:text-red-600"
              aria-label="Remove brand"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          }
        >
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div>
                <Label className="text-[12px] text-aurea-ink-3">Brand name</Label>
                <Input
                  value={brands[slug]?.name ?? ''}
                  onChange={(e) => setBrandField(slug, 'name', e.target.value)}
                  placeholder="e.g. Dion Health"
                  className="mt-1"
                />
              </div>
              <div>
                <Label className="text-[12px] text-aurea-ink-3">Doctor name (optional)</Label>
                <Input
                  value={brands[slug]?.doctorName ?? ''}
                  onChange={(e) => setBrandField(slug, 'doctorName', e.target.value)}
                  placeholder="e.g. Dr. Amin Samadian"
                  className="mt-1"
                />
              </div>
              <div>
                <Label className="text-[12px] text-aurea-ink-3">Website</Label>
                <Input
                  value={brands[slug]?.website ?? ''}
                  onChange={(e) => setBrandField(slug, 'website', e.target.value)}
                  placeholder="e.g. dionhealth.com"
                  className="mt-1"
                />
              </div>
            </div>
            <LogoField slug={slug} value={brands[slug]?.logoUrl ?? ''} onChange={(url) => setBrandField(slug, 'logoUrl', url)} />
            <div className="flex items-center gap-2">
              <input
                type="radio"
                id={`default-${slug}`}
                name="defaultBrand"
                checked={defaultBrand === slug}
                onChange={() => setDefaultBrand(slug)}
                className="h-3.5 w-3.5 accent-aurea-ink"
              />
              <Label htmlFor={`default-${slug}`} className="text-[12px] text-aurea-ink-3">
                Default brand (used when no service line matches)
              </Label>
            </div>
          </div>
        </SettingsCard>
      ))}

      <div>
        <Button type="button" variant="outline" onClick={addBrand} disabled={atLimit}>
          <Plus className="mr-2 h-4 w-4" />
          Add brand
        </Button>
        {atLimit && plan && (
          <p className="mt-2 text-[12px] text-aurea-ink-3">
            The {TIER_NAME[plan.tierId]} plan includes {plan.maxBrands} brand{plan.maxBrands === 1 ? '' : 's'}.{' '}
            <Link href="/settings/billing" className="underline underline-offset-2">Upgrade</Link> to add more.
          </p>
        )}
      </div>

      {/* ── Shared logistics ───────────────────────────────── */}
      <SettingsCard title="Location &amp; logistics (shared)">
        <div className="space-y-4">
          <div>
            <Label className="text-[12px] text-aurea-ink-3">Address</Label>
            <Input
              value={logistics.addressText}
              onChange={(e) => setLogistics((p) => ({ ...p, addressText: e.target.value }))}
              placeholder="123 Sutter St, Suite 400, San Francisco, CA 94108"
              className="mt-1"
            />
          </div>
          <div>
            <Label className="text-[12px] text-aurea-ink-3">By car</Label>
            <Input
              value={logistics.drivingText}
              onChange={(e) => setLogistics((p) => ({ ...p, drivingText: e.target.value }))}
              placeholder="At the corner of Sutter &amp; Powell, one block from Union Square…"
              className="mt-1"
            />
          </div>
          <div>
            <Label className="text-[12px] text-aurea-ink-3">Parking</Label>
            <Input
              value={logistics.parkingText}
              onChange={(e) => setLogistics((p) => ({ ...p, parkingText: e.target.value }))}
              placeholder="Validated parking at the Sutter-Stockton garage…"
              className="mt-1"
            />
          </div>
          <div>
            <Label className="text-[12px] text-aurea-ink-3">By BART / transit</Label>
            <Input
              value={logistics.transitText}
              onChange={(e) => setLogistics((p) => ({ ...p, transitText: e.target.value }))}
              placeholder="Powell St BART, 3-block walk up Powell to Sutter…"
              className="mt-1"
            />
          </div>
          <div>
            <Label className="text-[12px] text-aurea-ink-3">What to expect (email only)</Label>
            <Textarea
              value={logistics.whatToExpectText}
              onChange={(e) => setLogistics((p) => ({ ...p, whatToExpectText: e.target.value }))}
              placeholder="Arrive 10 minutes early. Bring your ID and insurance card. Your consultation lasts about 60 minutes…"
              rows={4}
              className="mt-1"
            />
          </div>
        </div>
      </SettingsCard>

      <Separator />

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          Save branding
        </Button>
      </div>
    </div>
  )
}

export default function BrandingSettingsPage() {
  return (
    <RoleGuard requiredPermission="branding:manage">
      <BrandingSettingsContent />
    </RoleGuard>
  )
}
