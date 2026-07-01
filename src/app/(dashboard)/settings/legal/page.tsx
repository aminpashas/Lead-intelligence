'use client'

import { useEffect, useState } from 'react'
import { RoleGuard } from '@/components/auth/role-guard'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'

type LegalForm = {
  entity_name: string
  state_of_formation: string
  street: string
  city: string
  state: string
  zip: string
  arbitration_venue: string
  governing_law: string
  cancellation_policy_days: number
  refund_policy_days: number
  attorney_name: string
  attorney_email: string
  attorney_phone: string
}

type ContractsForm = {
  send_method_default: string
  share_token_expiry_days: number
  auto_draft_on_ehr_accept: boolean
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

function LegalSettingsContent() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [legal, setLegal] = useState<LegalForm>({
    entity_name: '',
    state_of_formation: '',
    street: '',
    city: '',
    state: '',
    zip: '',
    arbitration_venue: '',
    governing_law: '',
    cancellation_policy_days: 3,
    refund_policy_days: 30,
    attorney_name: '',
    attorney_email: '',
    attorney_phone: '',
  })
  const [contracts, setContracts] = useState<ContractsForm>({
    send_method_default: 'email',
    share_token_expiry_days: 30,
    auto_draft_on_ehr_accept: true,
  })

  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/settings/legal')
      if (res.ok) {
        const data = await res.json()
        const l = data.legal ?? {}
        const addr = l.principal_address ?? {}
        const att = l.attorney_contact ?? {}
        setLegal({
          entity_name: l.entity_name ?? '',
          state_of_formation: l.state_of_formation ?? '',
          street: addr.street ?? '',
          city: addr.city ?? '',
          state: addr.state ?? '',
          zip: addr.zip ?? '',
          arbitration_venue: l.arbitration_venue ?? '',
          governing_law: l.governing_law ?? '',
          cancellation_policy_days: l.cancellation_policy_days ?? 3,
          refund_policy_days: l.refund_policy_days ?? 30,
          attorney_name: att.name ?? '',
          attorney_email: att.email ?? '',
          attorney_phone: att.phone ?? '',
        })
        const c = data.contracts ?? {}
        setContracts({
          send_method_default: c.send_method_default ?? 'email',
          share_token_expiry_days: c.share_token_expiry_days ?? 30,
          auto_draft_on_ehr_accept: c.auto_draft_on_ehr_accept ?? true,
        })
      }
      setLoading(false)
    })()
  }, [])

  const save = async () => {
    setSaving(true)
    const legalPayload = {
      entity_name: legal.entity_name || null,
      state_of_formation: legal.state_of_formation || null,
      principal_address:
        legal.street || legal.city || legal.state || legal.zip
          ? { street: legal.street, city: legal.city, state: legal.state, zip: legal.zip }
          : null,
      arbitration_venue: legal.arbitration_venue || null,
      governing_law: legal.governing_law || null,
      cancellation_policy_days: Number(legal.cancellation_policy_days) || 3,
      refund_policy_days: Number(legal.refund_policy_days) || 30,
      attorney_contact:
        legal.attorney_name || legal.attorney_email || legal.attorney_phone
          ? { name: legal.attorney_name, email: legal.attorney_email, phone: legal.attorney_phone }
          : null,
    }
    const res = await fetch('/api/settings/legal', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ legal: legalPayload, contracts }),
    })
    setSaving(false)
    if (res.ok) toast.success('Legal settings saved')
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
        <h1 className="aurea-display text-[40px] text-aurea-ink sm:text-[52px]">
          Legal &amp; Contract Settings
        </h1>
        <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-aurea-ink-2">
          Used to fill in boilerplate sections of every AI-drafted patient contract.
        </p>
      </header>

      {/* ── Practice legal entity ──────────────────────────── */}
      <SettingsCard title="Practice legal entity">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="col-span-2">
            <Label className="text-[12px] text-aurea-ink-3">Legal entity name</Label>
            <Input
              value={legal.entity_name}
              onChange={(e) => setLegal({ ...legal, entity_name: e.target.value })}
              placeholder="e.g. Aurea Dental Implants, PLLC"
              className="mt-1"
            />
          </div>
          <div>
            <Label className="text-[12px] text-aurea-ink-3">State of formation</Label>
            <Input
              value={legal.state_of_formation}
              onChange={(e) => setLegal({ ...legal, state_of_formation: e.target.value })}
              placeholder="CA"
              className="mt-1"
            />
          </div>
          <div>
            <Label className="text-[12px] text-aurea-ink-3">Governing law</Label>
            <Input
              value={legal.governing_law}
              onChange={(e) => setLegal({ ...legal, governing_law: e.target.value })}
              placeholder="State of California"
              className="mt-1"
            />
          </div>
        </div>
      </SettingsCard>

      {/* ── Principal office address ───────────────────────── */}
      <SettingsCard title="Principal office address">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="col-span-2">
            <Label className="text-[12px] text-aurea-ink-3">Street</Label>
            <Input value={legal.street} onChange={(e) => setLegal({ ...legal, street: e.target.value })} className="mt-1" />
          </div>
          <div>
            <Label className="text-[12px] text-aurea-ink-3">City</Label>
            <Input value={legal.city} onChange={(e) => setLegal({ ...legal, city: e.target.value })} className="mt-1" />
          </div>
          <div>
            <Label className="text-[12px] text-aurea-ink-3">State</Label>
            <Input value={legal.state} onChange={(e) => setLegal({ ...legal, state: e.target.value })} className="mt-1" />
          </div>
          <div>
            <Label className="text-[12px] text-aurea-ink-3">ZIP</Label>
            <Input value={legal.zip} onChange={(e) => setLegal({ ...legal, zip: e.target.value })} className="mt-1 font-mono" />
          </div>
        </div>
      </SettingsCard>

      {/* ── Dispute resolution & policies ─────────────────── */}
      <SettingsCard title="Dispute resolution &amp; policies">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="col-span-2">
            <Label className="text-[12px] text-aurea-ink-3">Arbitration venue</Label>
            <Input
              value={legal.arbitration_venue}
              onChange={(e) => setLegal({ ...legal, arbitration_venue: e.target.value })}
              placeholder="Los Angeles County, California"
              className="mt-1"
            />
          </div>
          <div>
            <Label className="text-[12px] text-aurea-ink-3">Cancellation window (days)</Label>
            <Input
              type="number"
              value={legal.cancellation_policy_days}
              onChange={(e) => setLegal({ ...legal, cancellation_policy_days: Number(e.target.value) })}
              className="mt-1 w-28 font-mono"
            />
          </div>
          <div>
            <Label className="text-[12px] text-aurea-ink-3">Refund window (days)</Label>
            <Input
              type="number"
              value={legal.refund_policy_days}
              onChange={(e) => setLegal({ ...legal, refund_policy_days: Number(e.target.value) })}
              className="mt-1 w-28 font-mono"
            />
          </div>
        </div>
      </SettingsCard>

      {/* ── Attorney of record ────────────────────────────── */}
      <SettingsCard title="Attorney of record (optional)">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <Label className="text-[12px] text-aurea-ink-3">Name</Label>
            <Input value={legal.attorney_name} onChange={(e) => setLegal({ ...legal, attorney_name: e.target.value })} className="mt-1" />
          </div>
          <div>
            <Label className="text-[12px] text-aurea-ink-3">Email</Label>
            <Input value={legal.attorney_email} onChange={(e) => setLegal({ ...legal, attorney_email: e.target.value })} className="mt-1" />
          </div>
          <div>
            <Label className="text-[12px] text-aurea-ink-3">Phone</Label>
            <Input value={legal.attorney_phone} onChange={(e) => setLegal({ ...legal, attorney_phone: e.target.value })} className="mt-1 font-mono" />
          </div>
        </div>
      </SettingsCard>

      {/* ── Contract automation ───────────────────────────── */}
      <SettingsCard title="Contract automation">
        <div className="space-y-4">
          <div>
            <Label className="text-[12px] text-aurea-ink-3">Portal link expiry (days)</Label>
            <Input
              type="number"
              value={contracts.share_token_expiry_days}
              onChange={(e) => setContracts({ ...contracts, share_token_expiry_days: Number(e.target.value) })}
              className="mt-1 w-28 font-mono"
            />
          </div>
          <div className="flex items-center gap-3">
            <input
              id="auto_draft"
              type="checkbox"
              className="h-4 w-4 rounded border-aurea-border accent-current"
              checked={contracts.auto_draft_on_ehr_accept}
              onChange={(e) => setContracts({ ...contracts, auto_draft_on_ehr_accept: e.target.checked })}
            />
            <label htmlFor="auto_draft" className="text-[13px] text-aurea-ink-2">
              Auto-draft a contract when CareStack reports a treatment plan as Accepted
            </label>
          </div>
        </div>
      </SettingsCard>

      <Separator />

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          Save settings
        </Button>
      </div>
    </div>
  )
}

export default function LegalSettingsPage() {
  return (
    <RoleGuard requiredPermission="legal_settings:manage">
      <LegalSettingsContent />
    </RoleGuard>
  )
}
