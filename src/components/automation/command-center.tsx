'use client'

import { useCallback, useState } from 'react'
import { SlidersHorizontal, Workflow, ShieldCheck } from 'lucide-react'
import type { AutomationPolicy } from '@/types/database'
import type { RegistryRow } from '@/lib/automation/matrix'
import { AutomationScoreboard } from './automation-scoreboard'
import { LiveControls } from './live-controls'
import { OwnershipMatrix } from './ownership-matrix'
import type {
  AutomationSettings,
  MatrixCampaign,
  MatrixStage,
  MatrixVoiceCampaign,
} from './types'

/**
 * Automation Command Center — one page that answers "who owns what work
 * right now, is everything running, and how are the two lanes performing?"
 */
export function AutomationCommandCenter({
  settings: initialSettings,
  policies: initialPolicies,
  campaigns,
  voiceCampaigns,
  stages,
  registryRows,
  counts,
  isAdmin,
  canKillSwitch,
}: {
  settings: AutomationSettings
  policies: AutomationPolicy[]
  campaigns: MatrixCampaign[]
  voiceCampaigns: MatrixVoiceCampaign[]
  stages: MatrixStage[]
  registryRows: RegistryRow[]
  counts: { activeCampaigns: number; activeVoiceCampaigns: number; enabledSequences: number }
  isAdmin: boolean
  canKillSwitch: boolean
}) {
  const [settings, setSettings] = useState(initialSettings)
  const [policies, setPolicies] = useState(initialPolicies)

  // Single refresh path: any editor that wrote a policy re-pulls the list so
  // every matrix cell recomputes from the same rows the runtime resolver sees.
  const refreshPolicies = useCallback(async () => {
    try {
      const res = await fetch('/api/automation/policies')
      if (!res.ok) return
      const json = await res.json()
      if (Array.isArray(json.policies)) setPolicies(json.policies)
    } catch {
      /* keep the stale list — the next edit retries */
    }
  }, [])

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-1 flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-aurea-primary" strokeWidth={1.75} />
          <h1 className="text-2xl font-bold text-aurea-ink">Automation</h1>
        </div>
        <p className="text-sm text-aurea-ink-2">
          Who — AI or your team — owns each kind of work, the live safety controls, and how
          both lanes are performing.
        </p>
      </div>

      <AutomationScoreboard />

      <LiveControls
        settings={settings}
        onSettingsChange={setSettings}
        policies={policies}
        onPoliciesChanged={refreshPolicies}
        isAdmin={isAdmin}
        canKillSwitch={canKillSwitch}
      />

      <OwnershipMatrix
        settings={settings}
        policies={policies}
        campaigns={campaigns}
        voiceCampaigns={voiceCampaigns}
        stages={stages}
        isAdmin={isAdmin}
        onPoliciesChanged={refreshPolicies}
      />

      <WorkflowRegistry rows={registryRows} counts={counts} />

      <GuardrailPanel settings={settings} />
    </div>
  )
}

// ── Workflow registry ────────────────────────────────────────────────

const HEALTH_STYLES: Record<RegistryRow['health'], { label: string; cls: string }> = {
  ok: { label: 'Healthy', cls: 'border-aurea-primary/30 bg-aurea-primary/10 text-aurea-primary' },
  stale: { label: 'Stale', cls: 'border-aurea-amber/30 bg-aurea-amber/10 text-aurea-amber' },
  failing: { label: 'Failing', cls: 'border-aurea-rose/30 bg-aurea-rose/10 text-aurea-rose' },
  never_ran: { label: 'No runs yet', cls: 'border-aurea-border bg-aurea-surface-2 text-aurea-ink-3' },
}

function timeAgo(iso: string | null): string {
  if (!iso) return '—'
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function WorkflowRegistry({
  rows,
  counts,
}: {
  rows: RegistryRow[]
  counts: { activeCampaigns: number; activeVoiceCampaigns: number; enabledSequences: number }
}) {
  const unhealthy = rows.filter((r) => r.health === 'failing' || r.health === 'stale').length

  return (
    <section className="aurea-card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Workflow className="h-4 w-4 text-aurea-primary" strokeWidth={1.75} />
          <h2 className="text-[15px] font-semibold text-aurea-ink">Workflow registry</h2>
          {unhealthy > 0 && (
            <span className="rounded border border-aurea-amber/30 bg-aurea-amber/10 px-1.5 py-0.5 text-[11px] font-medium text-aurea-amber">
              {unhealthy} need{unhealthy === 1 ? 's' : ''} attention
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[12px] text-aurea-ink-3">
          <span>
            <strong className="text-aurea-ink">{counts.activeCampaigns}</strong> active campaigns
          </span>
          <span>
            <strong className="text-aurea-ink">{counts.activeVoiceCampaigns}</strong> voice campaigns
          </span>
          <span>
            <strong className="text-aurea-ink">{counts.enabledSequences}</strong> sequences
          </span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-[12.5px]">
          <thead>
            <tr className="border-b border-aurea-border text-[10.5px] uppercase tracking-[0.08em] text-aurea-ink-3">
              <th className="py-2 pr-3 font-semibold">Workflow</th>
              <th className="py-2 pr-3 font-semibold">Schedule</th>
              <th className="py-2 pr-3 font-semibold">Last run</th>
              <th className="py-2 pr-3 font-semibold">Items</th>
              <th className="py-2 font-semibold">Health</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-aurea-border/60">
            {rows.map((row) => {
              const style = HEALTH_STYLES[row.health]
              return (
                <tr key={row.cron}>
                  <td className="py-2 pr-3 font-mono text-[12px] text-aurea-ink">{row.cron}</td>
                  <td className="py-2 pr-3 text-aurea-ink-2">{row.schedule}</td>
                  <td className="py-2 pr-3 text-aurea-ink-2" title={row.lastRanAt ?? undefined}>
                    {timeAgo(row.lastRanAt)}
                    {row.lastStatus && row.lastStatus !== 'ok' && (
                      <span className="ml-1.5 text-aurea-ink-3">({row.lastStatus})</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 tabular-nums text-aurea-ink-2">
                    {row.itemsProcessed ?? '—'}
                  </td>
                  <td className="py-2">
                    <span
                      className={`inline-flex rounded border px-1.5 py-0.5 text-[10.5px] font-medium ${style.cls}`}
                      title={row.lastError ?? undefined}
                    >
                      {style.label}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ── Guardrail panel (read-only) ──────────────────────────────────────

function GuardrailCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-l border-aurea-border-strong/60 pl-3">
      <div className="text-[10px] uppercase tracking-[0.1em] text-aurea-ink-3">{label}</div>
      <div className="mt-0.5 text-[13px] font-medium text-aurea-ink">{value}</div>
    </div>
  )
}

function GuardrailPanel({ settings }: { settings: AutomationSettings }) {
  const schedule = settings.autopilot_schedule
  const scheduleSummary = schedule
    ? 'Per-day week schedule active'
    : `Daily ${settings.autopilot_active_hours_start ?? 8}:00–${settings.autopilot_active_hours_end ?? 21}:00 (${settings.timezone || 'org timezone'})`

  return (
    <section className="aurea-card p-5">
      <div className="mb-4 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-aurea-primary" strokeWidth={1.75} />
        <h2 className="text-[15px] font-semibold text-aurea-ink">Guardrails</h2>
        <span className="text-[11.5px] text-aurea-ink-3">
          Always on — every AI send passes these gates. Edit in Settings → AI.
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
        <GuardrailCell label="Quiet hours" value={scheduleSummary} />
        <GuardrailCell
          label="Confidence floor"
          value={`${Math.round((settings.autopilot_confidence_threshold ?? 0.75) * 100)}% to auto-send`}
        />
        <GuardrailCell
          label="Rate limit"
          value={`${settings.autopilot_max_messages_per_hour ?? 10} msgs/hour per lead`}
        />
        <GuardrailCell
          label="Stop words"
          value={`${(settings.autopilot_stop_words ?? []).length} configured`}
        />
        <GuardrailCell label="Consent" value="Opt-outs & consent gates enforced on every send" />
      </div>
      <p className="mt-4 text-[11.5px] leading-relaxed text-aurea-ink-3">
        Medical questions always escalate to a human. AI agents also run per-agent daily
        discipline caps, and a takeover triggered by an expired human-response window still
        passes every one of these gates before anything is sent.
      </p>
    </section>
  )
}
