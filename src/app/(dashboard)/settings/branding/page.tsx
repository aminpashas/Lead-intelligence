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

function SettingsCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="aurea-card overflow-hidden">
      <div className="border-b border-aurea-border px-5 py-4">
        <h2 className="aurea-display text-[18px] text-aurea-ink">{title}</h2>
      </div>
      <div className="px-5 py-5">{children}</div>
    </section>
  )
}

function BrandingSettingsContent() {
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
          Each service line speaks its own brand on calls, texts, and emails. The doctor name is spoken only where set
          (leave blank for general dentistry). Parking &amp; transit is shared across all brands (one office).
        </p>
      </header>

      {/* ── Per-brand identity ─────────────────────────────── */}
      {BRAND_SLUGS.map((slug) => (
        <SettingsCard key={slug} title={BRAND_LABELS[slug] ?? slug}>
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
        </SettingsCard>
      ))}

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
            <Label className="text-[12px] text-aurea-ink-3">Parking</Label>
            <Input
              value={logistics.parkingText}
              onChange={(e) => setLogistics((p) => ({ ...p, parkingText: e.target.value }))}
              placeholder="Validated parking at the Sutter-Stockton garage…"
              className="mt-1"
            />
          </div>
          <div>
            <Label className="text-[12px] text-aurea-ink-3">Transit / BART</Label>
            <Input
              value={logistics.transitText}
              onChange={(e) => setLogistics((p) => ({ ...p, transitText: e.target.value }))}
              placeholder="BART: exit Montgomery St, 5-min walk up Sutter…"
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
