'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

type AdAccount = {
  id: string
  accountId: string
  name?: string
  currency?: string
  timezoneName?: string
  accountStatus?: number
  businessName?: string
}

type Pixel = {
  id: string
  name?: string
  lastFiredTime?: string
  adAccountId: string
}

export function MetaSelectForm({
  state,
  adAccounts,
  adAccountsError,
  pixelsByAccount,
}: {
  state: string
  adAccounts: AdAccount[]
  adAccountsError: string | null
  pixelsByAccount: Record<string, Pixel[]>
}) {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)

  // Flat pixel list so the radio selector pairs each Pixel with its
  // parent ad account in one click.
  const pixelOptions = useMemo(() => {
    const rows: Array<{ pixel: Pixel; account: AdAccount }> = []
    for (const acct of adAccounts) {
      const pixels = pixelsByAccount[acct.id] || []
      for (const p of pixels) rows.push({ pixel: p, account: acct })
    }
    return rows
  }, [adAccounts, pixelsByAccount])

  const defaultPixel = pixelOptions[0]?.pixel.id || ''
  const [pixelId, setPixelId] = useState(defaultPixel)
  const [manualPixelId, setManualPixelId] = useState('')
  const [testEventCode, setTestEventCode] = useState('')

  const selectedRow = pixelOptions.find((r) => r.pixel.id === pixelId)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const effectivePixelId = pixelId || manualPixelId.trim()
    if (!effectivePixelId) {
      toast.error('Pick a Pixel or enter one manually')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/connectors/oauth/meta/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state,
          pixelId: effectivePixelId,
          adAccountId: selectedRow?.account.id,
          ...(testEventCode ? { testEventCode } : {}),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to save selection')
        return
      }
      toast.success('Meta connected')
      router.push('/settings/connectors')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Meta Pixel</CardTitle>
          <CardDescription>
            The Pixel you pick is where CRM events land — consultations booked,
            cases closed, revenue. Pick the same Pixel your website fires client-side.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {adAccountsError && (
            <div className="text-xs rounded-md border border-amber-500/40 bg-amber-500/10 p-3 flex gap-2 items-start">
              <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
              <span className="text-amber-700 dark:text-amber-300">
                Couldn&apos;t list ad accounts: {adAccountsError}. You can still enter a
                Pixel ID manually below.
              </span>
            </div>
          )}

          {pixelOptions.length > 0 ? (
            <div className="space-y-2">
              <Label className="text-sm">Pick a Pixel</Label>
              <div className="space-y-1 max-h-80 overflow-y-auto rounded-md border p-2">
                {adAccounts.map((acct) => {
                  const pixels = pixelsByAccount[acct.id] || []
                  if (pixels.length === 0) return null
                  return (
                    <div key={acct.id}>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground px-2 pt-1 flex items-center gap-2">
                        <span>{acct.name || acct.accountId}</span>
                        {acct.businessName && (
                          <span className="opacity-60">· {acct.businessName}</span>
                        )}
                        {acct.currency && <span className="opacity-60">· {acct.currency}</span>}
                        {acct.accountStatus !== 1 && (
                          <span className="text-amber-600">· Inactive</span>
                        )}
                      </div>
                      {pixels.map((p) => (
                        <label
                          key={p.id}
                          className="flex items-center gap-2 cursor-pointer hover:bg-muted/60 rounded p-2 text-sm"
                        >
                          <input
                            type="radio"
                            name="meta-pixel"
                            value={p.id}
                            checked={pixelId === p.id}
                            onChange={(e) => {
                              setPixelId(e.target.value)
                              setManualPixelId('')
                            }}
                          />
                          <span className="font-mono text-xs text-muted-foreground w-32">
                            {p.id}
                          </span>
                          <span className="flex-1">
                            {p.name || <span className="text-muted-foreground italic">Untitled</span>}
                          </span>
                          {p.lastFiredTime && (
                            <span className="text-[10px] text-muted-foreground">
                              last event {new Date(p.lastFiredTime).toLocaleDateString()}
                            </span>
                          )}
                        </label>
                      ))}
                    </div>
                  )
                })}
              </div>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              No Pixels were found on your accessible ad accounts. Enter one manually below.
            </div>
          )}

          <div className="space-y-1 pt-2 border-t">
            <Label className="text-sm">Or paste a Pixel ID manually</Label>
            <Input
              value={manualPixelId}
              onChange={(e) => {
                setManualPixelId(e.target.value)
                if (e.target.value) setPixelId('')
              }}
              placeholder="123456789012345"
              className="font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              Useful if your Pixel lives on an ad account we couldn&apos;t enumerate.
            </p>
          </div>

          <div className="space-y-1 pt-2 border-t">
            <Label className="text-sm">Test Event Code (optional)</Label>
            <Input
              value={testEventCode}
              onChange={(e) => setTestEventCode(e.target.value)}
              placeholder="TEST12345"
              className="font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              Routes CAPI events to Events Manager&apos;s test view so you can verify payloads
              without polluting production data. Remove once you&apos;ve confirmed events land
              correctly.
            </p>
          </div>
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
        <Button
          type="submit"
          disabled={submitting || (!pixelId && !manualPixelId.trim())}
        >
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
