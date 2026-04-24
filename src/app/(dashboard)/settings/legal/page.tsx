'use client'

import { useEffect, useState } from 'react'
import { RoleGuard } from '@/components/auth/role-guard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
      <div className="p-6 flex items-center justify-center min-h-[60vh]">
        <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
      </div>
    )
  }

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Legal & Contract Settings</h1>
        <p className="text-sm text-slate-500 mt-1">
          Used to fill in boilerplate sections of every AI-drafted patient contract.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Practice legal entity</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="col-span-2">
            <Label>Legal entity name</Label>
            <Input value={legal.entity_name} onChange={(e) => setLegal({ ...legal, entity_name: e.target.value })} placeholder='e.g. Aurea Dental Implants, PLLC' />
          </div>
          <div>
            <Label>State of formation</Label>
            <Input value={legal.state_of_formation} onChange={(e) => setLegal({ ...legal, state_of_formation: e.target.value })} placeholder="CA" />
          </div>
          <div>
            <Label>Governing law</Label>
            <Input value={legal.governing_law} onChange={(e) => setLegal({ ...legal, governing_law: e.target.value })} placeholder="State of California" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Principal office address</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="col-span-2">
            <Label>Street</Label>
            <Input value={legal.street} onChange={(e) => setLegal({ ...legal, street: e.target.value })} />
          </div>
          <div>
            <Label>City</Label>
            <Input value={legal.city} onChange={(e) => setLegal({ ...legal, city: e.target.value })} />
          </div>
          <div>
            <Label>State</Label>
            <Input value={legal.state} onChange={(e) => setLegal({ ...legal, state: e.target.value })} />
          </div>
          <div>
            <Label>ZIP</Label>
            <Input value={legal.zip} onChange={(e) => setLegal({ ...legal, zip: e.target.value })} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Dispute resolution & policies</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="col-span-2">
            <Label>Arbitration venue</Label>
            <Input value={legal.arbitration_venue} onChange={(e) => setLegal({ ...legal, arbitration_venue: e.target.value })} placeholder="Los Angeles County, California" />
          </div>
          <div>
            <Label>Cancellation window (days)</Label>
            <Input type="number" value={legal.cancellation_policy_days} onChange={(e) => setLegal({ ...legal, cancellation_policy_days: Number(e.target.value) })} />
          </div>
          <div>
            <Label>Refund window (days)</Label>
            <Input type="number" value={legal.refund_policy_days} onChange={(e) => setLegal({ ...legal, refund_policy_days: Number(e.target.value) })} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Attorney of record (optional)</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <Label>Name</Label>
            <Input value={legal.attorney_name} onChange={(e) => setLegal({ ...legal, attorney_name: e.target.value })} />
          </div>
          <div>
            <Label>Email</Label>
            <Input value={legal.attorney_email} onChange={(e) => setLegal({ ...legal, attorney_email: e.target.value })} />
          </div>
          <div>
            <Label>Phone</Label>
            <Input value={legal.attorney_phone} onChange={(e) => setLegal({ ...legal, attorney_phone: e.target.value })} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Contract automation</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Portal link expiry (days)</Label>
            <Input
              type="number"
              value={contracts.share_token_expiry_days}
              onChange={(e) => setContracts({ ...contracts, share_token_expiry_days: Number(e.target.value) })}
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              id="auto_draft"
              type="checkbox"
              className="h-4 w-4"
              checked={contracts.auto_draft_on_ehr_accept}
              onChange={(e) => setContracts({ ...contracts, auto_draft_on_ehr_accept: e.target.checked })}
            />
            <label htmlFor="auto_draft" className="text-sm">
              Auto-draft a contract when CareStack reports a treatment plan as Accepted
            </label>
          </div>
        </CardContent>
      </Card>

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
