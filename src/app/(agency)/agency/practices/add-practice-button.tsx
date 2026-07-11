'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Plus, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

type Enterprise = { id: string; name: string }

const TIERS = ['trial', 'starter', 'professional', 'enterprise'] as const
const STANDALONE = 'standalone'

/**
 * Onboards a new client practice (location) from the agency portal. Creates the
 * org via /api/agency/practices (which seeds default pipeline stages), optionally
 * under an enterprise (DSO) umbrella and with per-location pricing. Each location
 * bills independently, so the pricing here seeds THIS org's config.
 */
export function AddPracticeButton() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')

  const [enterprises, setEnterprises] = useState<Enterprise[]>([])
  const [enterpriseId, setEnterpriseId] = useState<string>(STANDALONE)
  const [tier, setTier] = useState<string>('trial')
  const [platformFee, setPlatformFee] = useState('') // dollars/month
  const [markupPct, setMarkupPct] = useState('') // uniform %, applied to all services

  // Load enterprises when the dialog opens so a location can be grouped at creation.
  useEffect(() => {
    if (!open) return
    fetch('/api/agency/enterprises')
      .then((r) => (r.ok ? r.json() : { enterprises: [] }))
      .then((d) => setEnterprises(d.enterprises ?? []))
      .catch(() => setEnterprises([]))
  }, [open])

  async function create() {
    if (!name.trim()) {
      toast.error('Practice name is required')
      return
    }
    setSaving(true)
    try {
      // Uniform markup → per-service map the pricing engine expects.
      const pct = markupPct.trim() === '' ? undefined : Number(markupPct)
      const markups =
        pct !== undefined && Number.isFinite(pct)
          ? { ai: pct, sms: pct, voice: pct, email: pct }
          : undefined
      const feeDollars = platformFee.trim() === '' ? undefined : Number(platformFee)
      const platform_fee_cents =
        feeDollars !== undefined && Number.isFinite(feeDollars)
          ? Math.round(feeDollars * 100)
          : undefined

      const res = await fetch('/api/agency/practices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          email,
          phone,
          ...(enterpriseId !== STANDALONE ? { enterprise_account_id: enterpriseId } : {}),
          ...(tier !== 'trial' ? { subscription_tier: tier } : {}),
          ...(markups ? { markups } : {}),
          ...(platform_fee_cents !== undefined ? { platform_fee_cents } : {}),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error || 'Could not create practice')
        return
      }
      const data = await res.json().catch(() => ({}))
      if (data.warning) toast.warning(data.warning)
      toast.success(`${name.trim()} added`)
      setOpen(false)
      setName('')
      setEmail('')
      setPhone('')
      setEnterpriseId(STANDALONE)
      setTier('trial')
      setPlatformFee('')
      setMarkupPct('')
      router.refresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <Plus className="h-4 w-4 mr-1.5" />
        Add practice
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a client practice</DialogTitle>
          <DialogDescription>
            Creates a new location account. Optionally group it under an enterprise
            and set its pricing — each location bills independently.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="practice-name">
              Practice name <span className="text-aurea-rose">*</span>
            </Label>
            <Input
              id="practice-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Dion Health Los Angeles"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="practice-enterprise">Enterprise (optional)</Label>
            <Select value={enterpriseId} onValueChange={(v) => v && setEnterpriseId(v)}>
              <SelectTrigger id="practice-enterprise">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={STANDALONE}>Standalone (no enterprise)</SelectItem>
                {enterprises.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="practice-tier">Subscription tier</Label>
              <Select value={tier} onValueChange={(v) => v && setTier(v)}>
                <SelectTrigger id="practice-tier">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIERS.map((t) => (
                    <SelectItem key={t} value={t} className="capitalize">
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="practice-fee">Platform fee ($/mo)</Label>
              <Input
                id="practice-fee"
                inputMode="decimal"
                value={platformFee}
                onChange={(e) => setPlatformFee(e.target.value)}
                placeholder="1500"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="practice-markup">Usage markup % (all services, optional)</Label>
            <Input
              id="practice-markup"
              inputMode="decimal"
              value={markupPct}
              onChange={(e) => setMarkupPct(e.target.value)}
              placeholder="200 = 3× re-bill (leave blank for platform default)"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="practice-email">Email (optional)</Label>
              <Input
                id="practice-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="hello@practice.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="practice-phone">Phone (optional)</Label>
              <Input
                id="practice-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 555 123 4567"
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={create} disabled={saving || !name.trim()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Plus className="h-4 w-4 mr-1.5" />}
            Create practice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
