'use client'

/**
 * FinancingPrequalSettings — the account-level financing switchboard.
 *
 * Two switches, deliberately distinct:
 *   1. Pre-qualification (financing_prequal_enabled) — lights up the per-lead
 *      "Send Pre-Qual" button. Manual, human-in-the-loop.
 *   2. Automatic sending (financing_auto_send_enabled) — arms the AI to send a
 *      financing link on its own when it judges a lead "ready". Nested under (1)
 *      and default-OFF, with copy that spells out exactly what turning it on
 *      changes, because it's the switch that lets the AI start the conversation.
 *
 * `canWrite` reflects `ai_control:write` (agency-side). Practice admins see the
 * state read-only; only the agency flips it.
 */

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

export function FinancingPrequalSettings({
  initialPrequalEnabled,
  initialAutoSendEnabled,
  canWrite,
}: {
  initialPrequalEnabled: boolean
  initialAutoSendEnabled: boolean
  canWrite: boolean
}) {
  const [prequal, setPrequal] = useState(initialPrequalEnabled)
  const [autoSend, setAutoSend] = useState(initialAutoSendEnabled)
  const [pending, setPending] = useState<'prequal' | 'auto' | null>(null)

  async function save(
    patch: { financing_prequal_enabled?: boolean; financing_auto_send_enabled?: boolean },
    key: 'prequal' | 'auto'
  ) {
    if (!canWrite) return
    setPending(key)
    // Optimistic — reflect immediately, roll back on failure.
    const prev = { prequal, autoSend }
    if (patch.financing_prequal_enabled !== undefined) {
      setPrequal(patch.financing_prequal_enabled)
      // Turning the feature off also disarms auto-send (server enforces this too).
      if (patch.financing_prequal_enabled === false) setAutoSend(false)
    }
    if (patch.financing_auto_send_enabled !== undefined) setAutoSend(patch.financing_auto_send_enabled)

    try {
      const res = await fetch('/api/settings/financing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || 'Update failed')
      // Trust the server's canonical values.
      setPrequal(!!data.feature_flags?.financing_prequal_enabled)
      setAutoSend(!!data.feature_flags?.financing_auto_send_enabled)
      toast.success('Financing settings updated')
    } catch (e) {
      setPrequal(prev.prequal)
      setAutoSend(prev.autoSend)
      toast.error(e instanceof Error ? e.message : 'Could not update settings')
    } finally {
      setPending(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pre-Qualification</CardTitle>
        <CardDescription>
          Let staff invite an engaged patient to check what financing they prequalify for — a soft credit
          check that won&apos;t affect their score.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Master toggle — lights up the per-lead "Send Pre-Qual" button. */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium text-aurea-ink">Enable pre-qualification</div>
            <p className="max-w-prose text-[13px] text-aurea-ink-3">
              When on, a <span className="font-medium">Send Pre-Qual</span> button appears on each lead (in the
              lead detail and conversation views). Financing only ever goes out when a staff member clicks it —
              the AI does not send anything on its own.
            </p>
          </div>
          <div className="flex items-center gap-2 pt-0.5">
            {pending === 'prequal' && <Loader2 className="h-4 w-4 animate-spin text-aurea-ink-3" strokeWidth={1.75} />}
            <Switch
              checked={prequal}
              disabled={!canWrite || pending !== null}
              onCheckedChange={(v) => save({ financing_prequal_enabled: v }, 'prequal')}
            />
          </div>
        </div>

        {/* Nested auto-send — the "let the AI start it" switch. */}
        <div
          className={`rounded-lg border border-aurea-border bg-aurea-surface-2/40 p-4 transition-opacity ${
            prequal ? '' : 'pointer-events-none opacity-50'
          }`}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="text-sm font-medium text-aurea-ink">
                Let the AI send financing automatically
              </div>
              <p className="max-w-prose text-[13px] text-aurea-ink-3">
                When on, the AI decides when a lead looks &ldquo;ready&rdquo; and sends the financing link without a
                click. <span className="font-medium text-aurea-ink">Keep this off</span> while the goal is building
                rapport toward a booked consult — turn it on only when you want financing to go out hands-free.
              </p>
            </div>
            <div className="flex items-center gap-2 pt-0.5">
              {pending === 'auto' && <Loader2 className="h-4 w-4 animate-spin text-aurea-ink-3" strokeWidth={1.75} />}
              <Switch
                checked={autoSend}
                disabled={!canWrite || !prequal || pending !== null}
                onCheckedChange={(v) => save({ financing_auto_send_enabled: v }, 'auto')}
              />
            </div>
          </div>
        </div>

        {!canWrite && (
          <p className="text-[13px] text-aurea-ink-3">
            These controls are managed by your agency. Ask your agency contact to change them.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
