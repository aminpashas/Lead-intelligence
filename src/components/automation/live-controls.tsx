'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Loader2, OctagonX, Play, Radio } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { AutomationPolicy } from '@/types/database'
import type { AutomationSettings } from './types'

/**
 * Live controls — the switches that change behavior RIGHT NOW:
 *   * kill switch / resume (autopilot_paused, POST /api/autopilot/kill-switch)
 *   * shadow mode (autopilot_outreach_suppressed) — leaving shadow requires an
 *     explicit confirm spelling out that the AI will send real messages
 *   * human-first response window master toggle + seconds
 *   * org-default owner quick-set (writes the org_default automation_policy)
 */
export function LiveControls({
  settings,
  onSettingsChange,
  policies,
  onPoliciesChanged,
  isAdmin,
  canKillSwitch,
}: {
  settings: AutomationSettings
  onSettingsChange: (next: AutomationSettings) => void
  policies: AutomationPolicy[]
  onPoliciesChanged: () => Promise<void> | void
  isAdmin: boolean
  canKillSwitch: boolean
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmGoLive, setConfirmGoLive] = useState(false)
  const [slaSeconds, setSlaSeconds] = useState(settings.human_first_sla_seconds ?? 180)

  const paused = settings.autopilot_paused ?? false
  const shadow = settings.autopilot_outreach_suppressed ?? false
  const slaEnabled = settings.human_first_sla_enabled ?? false
  const orgDefaultPolicy = policies.find((p) => p.scope === 'org_default') ?? null

  async function patchSettings(updates: Partial<AutomationSettings>, busyKey: string) {
    setBusy(busyKey)
    try {
      const res = await fetch('/api/autopilot/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(json?.error || 'Save failed')
      onSettingsChange({ ...settings, ...updates })
      return true
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save')
      return false
    } finally {
      setBusy(null)
    }
  }

  async function killSwitch() {
    setBusy('kill')
    try {
      const res = await fetch('/api/autopilot/kill-switch', { method: 'POST' })
      if (!res.ok) throw new Error('Kill switch failed')
      onSettingsChange({ ...settings, autopilot_paused: true })
      toast.success('AI PAUSED — no messages will be sent', { duration: 5000 })
    } catch {
      toast.error('Failed to activate the kill switch')
    } finally {
      setBusy(null)
    }
  }

  async function resume() {
    if (await patchSettings({ autopilot_paused: false }, 'kill')) {
      toast.success('AI resumed')
    }
  }

  async function setShadow(next: boolean) {
    if (await patchSettings({ autopilot_outreach_suppressed: next }, 'shadow')) {
      toast.success(
        next
          ? 'Shadow mode ON — the AI drafts and scores but sends nothing'
          : 'Shadow mode OFF — the AI is live and sending'
      )
    }
  }

  async function setOrgOwner(owner: 'ai' | 'human' | 'hybrid') {
    setBusy(`owner-${owner}`)
    try {
      const res = await fetch('/api/automation/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'org_default',
          owner,
          // Preserve the rest of an existing org policy; the editor in the
          // matrix below is the place for fine tuning.
          ai_role: orgDefaultPolicy?.ai_role ?? null,
          human_first: orgDefaultPolicy?.human_first ?? false,
          human_response_sla_seconds: orgDefaultPolicy?.human_response_sla_seconds ?? 180,
          kinds: orgDefaultPolicy?.kinds ?? [],
          human_schedule:
            owner === 'hybrid' ? (orgDefaultPolicy?.human_schedule ?? null) : null,
          enabled: true,
        }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        throw new Error(json?.error || 'Save failed')
      }
      toast.success(`Org default owner set to ${owner === 'ai' ? 'AI' : owner}`)
      await onPoliciesChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to set org default')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section
      className={`aurea-card p-5 ${paused ? 'bg-aurea-rose/[0.03] ring-1 ring-aurea-rose/30' : ''}`}
    >
      <div className="mb-4 flex items-center gap-2">
        <Radio className="h-4 w-4 text-aurea-primary" strokeWidth={1.75} />
        <h2 className="text-[15px] font-semibold text-aurea-ink">Live controls</h2>
        {paused && (
          <span className="rounded border border-aurea-rose/30 bg-aurea-rose/10 px-1.5 py-0.5 text-[11px] font-semibold text-aurea-rose">
            AI PAUSED
          </span>
        )}
        {!paused && shadow && (
          <span className="rounded border border-aurea-amber/30 bg-aurea-amber/10 px-1.5 py-0.5 text-[11px] font-semibold text-aurea-amber">
            SHADOW MODE
          </span>
        )}
      </div>

      <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
        {/* Kill switch */}
        <div className="space-y-2">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-aurea-ink-3">
            Emergency stop
          </div>
          {paused ? (
            <Button
              size="sm"
              variant="outline"
              onClick={resume}
              disabled={busy === 'kill' || !isAdmin}
              className="gap-1.5"
            >
              {busy === 'kill' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" strokeWidth={1.75} />}
              Resume AI
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={killSwitch}
              disabled={busy === 'kill' || !canKillSwitch}
              className="gap-1.5 border-aurea-rose/40 text-aurea-rose hover:bg-aurea-rose/10 hover:text-aurea-rose"
            >
              {busy === 'kill' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <OctagonX className="h-3.5 w-3.5" strokeWidth={1.75} />}
              Pause all AI sends
            </Button>
          )}
          <p className="text-[11px] leading-relaxed text-aurea-ink-3">
            Instantly stops every AI auto-send. {paused ? 'Resuming re-arms autopilot.' : 'Nothing else changes.'}
          </p>
        </div>

        {/* Shadow mode */}
        <div className="space-y-2">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-aurea-ink-3">
            Shadow mode
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={shadow}
              disabled={busy === 'shadow' || !isAdmin}
              onCheckedChange={(v) => {
                if (!v) {
                  // Leaving shadow = real sends. Make the human say it out loud.
                  setConfirmGoLive(true)
                } else {
                  setShadow(true)
                }
              }}
            />
            <span className="text-[12.5px] text-aurea-ink-2">
              {shadow ? 'On — drafts only, nothing sends' : 'Off — AI sends for real'}
            </span>
          </div>
          <p className="text-[11px] leading-relaxed text-aurea-ink-3">
            In shadow mode agents score and draft but never message a lead.
          </p>
        </div>

        {/* Human-first response window */}
        <div className="space-y-2">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-aurea-ink-3">
            Human response window
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={slaEnabled}
              disabled={busy === 'sla' || !isAdmin}
              onCheckedChange={(v) =>
                patchSettings({ human_first_sla_enabled: !!v }, 'sla').then(
                  (ok) => ok && toast.success(v ? 'Human-first window ON' : 'Human-first window OFF')
                )
              }
            />
            <label className="flex items-center gap-1 text-[12px] text-aurea-ink-2">
              <input
                type="number"
                min={30}
                max={3600}
                step={30}
                value={slaSeconds}
                disabled={!slaEnabled || !isAdmin}
                onChange={(e) => setSlaSeconds(Number(e.target.value))}
                onBlur={() => {
                  const v = Math.min(3600, Math.max(30, slaSeconds))
                  setSlaSeconds(v)
                  if (v !== (settings.human_first_sla_seconds ?? 180)) {
                    patchSettings({ human_first_sla_seconds: v }, 'sla')
                  }
                }}
                className="w-20 rounded border border-aurea-border bg-aurea-canvas px-1.5 py-1 text-[12px] tabular-nums disabled:opacity-40"
              />
              sec
            </label>
          </div>
          <p className="text-[11px] leading-relaxed text-aurea-ink-3">
            Inbound replies wait for your team this long before the AI answers.
          </p>
        </div>

        {/* Org default owner quick-set */}
        <div className="space-y-2">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-aurea-ink-3">
            Org default owner
          </div>
          <div className="inline-flex overflow-hidden rounded-lg border border-aurea-border">
            {(['ai', 'human', 'hybrid'] as const).map((o) => {
              const active = orgDefaultPolicy ? orgDefaultPolicy.owner === o : o === 'ai'
              return (
                <button
                  key={o}
                  type="button"
                  disabled={!isAdmin || busy?.startsWith('owner-')}
                  onClick={() => setOrgOwner(o)}
                  className={`px-3 py-1.5 text-[12px] font-medium capitalize transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    active
                      ? 'bg-aurea-ink text-aurea-canvas'
                      : 'text-aurea-ink-3 hover:bg-aurea-surface-2 hover:text-aurea-ink'
                  }`}
                >
                  {busy === `owner-${o}` ? <Loader2 className="h-3 w-3 animate-spin" /> : o === 'ai' ? 'AI' : o}
                </button>
              )
            })}
          </div>
          <p className="text-[11px] leading-relaxed text-aurea-ink-3">
            {orgDefaultPolicy
              ? 'Backed by your org-default policy — fine-tune it in the matrix below.'
              : 'No org policy yet — everything defaults to AI. Setting one creates it.'}
          </p>
        </div>
      </div>

      {!isAdmin && (
        <p className="mt-4 text-[11.5px] text-aurea-ink-3">
          Shadow mode, the response window and ownership are managed by your agency; the
          emergency stop stays available to practice admins.
        </p>
      )}

      {/* Go-live confirm — the one toggle that starts real outbound messages. */}
      <Dialog open={confirmGoLive} onOpenChange={setConfirmGoLive}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-aurea-amber" strokeWidth={1.75} />
              Turn off shadow mode?
            </DialogTitle>
            <DialogDescription>
              The AI will start sending <strong>real messages to real leads</strong> — texts and
              emails go out the moment its gates approve them, without a human reviewing each
              one. Quiet hours, stop words, consent and confidence gates stay enforced.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmGoLive(false)}>
              Stay in shadow
            </Button>
            <Button
              size="sm"
              disabled={busy === 'shadow'}
              onClick={async () => {
                await setShadow(false)
                setConfirmGoLive(false)
              }}
              className="gap-1.5"
            >
              {busy === 'shadow' && <Loader2 className="h-3 w-3 animate-spin" />}
              Go live — AI sends real messages
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
