'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

type AdsCustomer = {
  customerId: string
  descriptiveName?: string
  currencyCode?: string
  timeZone?: string
  manager?: boolean
}

type GA4Account = {
  account: string
  accountDisplay: string
  propertySummaries: Array<{
    property: string
    propertyId: string
    displayName: string
  }>
}

export function GoogleSelectForm({
  state,
  adsCustomers,
  adsError,
  ga4Accounts,
  ga4Error,
}: {
  state: string
  adsCustomers: AdsCustomer[]
  adsError: string | null
  ga4Accounts: GA4Account[]
  ga4Error: string | null
}) {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)

  // Ads selection — default to first non-manager if present.
  const defaultAds = adsCustomers.find((c) => !c.manager)?.customerId || adsCustomers[0]?.customerId || ''
  const [adsCustomerId, setAdsCustomerId] = useState(defaultAds)
  const [loginCustomerId, setLoginCustomerId] = useState('')

  // GA4 selection — flatten properties so the user picks one directly.
  const allProperties = ga4Accounts.flatMap((a) =>
    a.propertySummaries.map((p) => ({
      ...p,
      accountDisplay: a.accountDisplay,
    }))
  )
  const [ga4PropertyId, setGa4PropertyId] = useState(allProperties[0]?.propertyId || '')
  const [measurementId, setMeasurementId] = useState('')
  const [apiSecret, setApiSecret] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!adsCustomerId && !ga4PropertyId) {
      toast.error('Pick at least one account to bind')
      return
    }
    setSubmitting(true)
    try {
      const body: {
        state: string
        ads?: { customerId: string; loginCustomerId?: string } | null
        ga4?: { propertyId: string; measurementId: string; apiSecret?: string } | null
      } = { state }
      if (adsCustomerId) {
        body.ads = {
          customerId: adsCustomerId,
          ...(loginCustomerId ? { loginCustomerId } : {}),
        }
      }
      if (ga4PropertyId) {
        body.ga4 = {
          propertyId: ga4PropertyId,
          measurementId,
          ...(apiSecret ? { apiSecret } : {}),
        }
      }

      const res = await fetch('/api/connectors/oauth/google/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to save selection')
        return
      }
      toast.success(`Connected: ${data.connected.join(', ')}`)
      router.push('/settings/connectors')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Google Ads section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Google Ads</CardTitle>
          <CardDescription>
            Pick the customer ID to receive offline conversions. If you use an MCC,
            select the child account here and enter the MCC ID below.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {adsError && (
            <div className="text-xs rounded-md border border-amber-500/40 bg-amber-500/10 p-3 flex gap-2 items-start">
              <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
              <span className="text-amber-700 dark:text-amber-300">
                Couldn&apos;t list Google Ads accounts: {adsError}. You can skip this
                section and reconnect later, or paste the customer ID manually below.
              </span>
            </div>
          )}

          {adsCustomers.length > 0 ? (
            <div className="space-y-2">
              <Label className="text-sm">Ads customer</Label>
              <div className="space-y-1 max-h-64 overflow-y-auto rounded-md border p-2">
                {adsCustomers.map((c) => (
                  <label
                    key={c.customerId}
                    className="flex items-center gap-2 cursor-pointer hover:bg-muted/60 rounded p-2 text-sm"
                  >
                    <input
                      type="radio"
                      name="ads-customer"
                      value={c.customerId}
                      checked={adsCustomerId === c.customerId}
                      onChange={(e) => setAdsCustomerId(e.target.value)}
                    />
                    <span className="font-mono text-xs text-muted-foreground w-28">
                      {formatCustomerId(c.customerId)}
                    </span>
                    <span className="flex-1">
                      {c.descriptiveName || <span className="text-muted-foreground italic">Untitled</span>}
                      {c.manager && (
                        <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                          MCC
                        </span>
                      )}
                    </span>
                    {c.currencyCode && (
                      <span className="text-[10px] text-muted-foreground">{c.currencyCode}</span>
                    )}
                  </label>
                ))}
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground mt-2">
                <input
                  type="radio"
                  name="ads-customer"
                  value=""
                  checked={adsCustomerId === ''}
                  onChange={() => setAdsCustomerId('')}
                />
                Skip Google Ads — connect later
              </label>
            </div>
          ) : (
            <div className="space-y-1">
              <Label className="text-sm">Ads customer ID (manual)</Label>
              <Input
                value={adsCustomerId}
                onChange={(e) => setAdsCustomerId(e.target.value)}
                placeholder="123-456-7890 or 1234567890"
                className="font-mono text-xs"
              />
            </div>
          )}

          {adsCustomerId && (
            <div className="space-y-1">
              <Label className="text-sm">MCC account ID (optional)</Label>
              <Input
                value={loginCustomerId}
                onChange={(e) => setLoginCustomerId(e.target.value)}
                placeholder="Leave blank if not using MCC"
                className="font-mono text-xs"
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* GA4 section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Google Analytics 4</CardTitle>
          <CardDescription>
            Pick the GA4 property to send pipeline events to. You&apos;ll also need the
            Measurement ID and a Measurement Protocol API Secret from GA4 Admin →
            Data Streams.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {ga4Error && (
            <div className="text-xs rounded-md border border-amber-500/40 bg-amber-500/10 p-3 flex gap-2 items-start">
              <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
              <span className="text-amber-700 dark:text-amber-300">
                Couldn&apos;t list GA4 properties: {ga4Error}.
              </span>
            </div>
          )}

          {allProperties.length > 0 && (
            <div className="space-y-2">
              <Label className="text-sm">GA4 property</Label>
              <div className="space-y-1 max-h-64 overflow-y-auto rounded-md border p-2">
                {ga4Accounts.map((acct) => (
                  <div key={acct.account}>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground px-2 pt-1">
                      {acct.accountDisplay}
                    </div>
                    {acct.propertySummaries.map((p) => (
                      <label
                        key={p.propertyId}
                        className="flex items-center gap-2 cursor-pointer hover:bg-muted/60 rounded p-2 text-sm"
                      >
                        <input
                          type="radio"
                          name="ga4-property"
                          value={p.propertyId}
                          checked={ga4PropertyId === p.propertyId}
                          onChange={(e) => setGa4PropertyId(e.target.value)}
                        />
                        <span className="font-mono text-xs text-muted-foreground w-20">
                          {p.propertyId}
                        </span>
                        <span className="flex-1">{p.displayName}</span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground mt-2">
                <input
                  type="radio"
                  name="ga4-property"
                  value=""
                  checked={ga4PropertyId === ''}
                  onChange={() => setGa4PropertyId('')}
                />
                Skip GA4 — connect later
              </label>
            </div>
          )}

          {ga4PropertyId && (
            <>
              <div className="space-y-1">
                <Label className="text-sm">Measurement ID</Label>
                <Input
                  value={measurementId}
                  onChange={(e) => setMeasurementId(e.target.value)}
                  placeholder="G-XXXXXXXXXX"
                  className="font-mono text-xs"
                />
                <p className="text-[11px] text-muted-foreground">
                  Find in GA4 Admin → Data Streams → your web stream.
                </p>
              </div>
              <div className="space-y-1">
                <Label className="text-sm">Measurement Protocol API Secret</Label>
                <Input
                  type="password"
                  value={apiSecret}
                  onChange={(e) => setApiSecret(e.target.value)}
                  placeholder="Leave blank to enable later"
                  className="font-mono text-xs"
                />
                <p className="text-[11px] text-muted-foreground">
                  Create one in GA4 Admin → Data Streams → [stream] → Measurement Protocol API secrets.
                  Without this, GA4 stays connected but paused.
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.push('/settings/connectors')}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={submitting || (!adsCustomerId && !ga4PropertyId)}>
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : (
            <CheckCircle2 className="h-4 w-4 mr-2" />
          )}
          Finish connecting
        </Button>
      </div>
    </form>
  )
}

function formatCustomerId(id: string): string {
  const d = id.replace(/\D/g, '')
  if (d.length !== 10) return id
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`
}
