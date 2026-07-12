'use client'

import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  Bot,
  User,
  Clock,
  CalendarClock,
  ExternalLink,
  Loader2,
  Pencil,
  Trash2,
  Grid3x3,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import type { AutomationPolicy } from '@/types/database'
import type { AllocationKind, AllocationOrgConfig } from '@/lib/automation/allocation'
import type { WeekSchedule } from '@/lib/autopilot/config'
import { deriveOwnerCell, deriveVoiceOwner, WORK_KINDS, type MatrixOwner, type OwnerCell } from '@/lib/automation/matrix'
import type { AutomationSettings, MatrixCampaign, MatrixStage, MatrixVoiceCampaign } from './types'

/**
 * Ownership matrix — who owns each kind of work, at org level and per
 * campaign / voice campaign / pipeline stage. Every cell is computed with the
 * SAME resolveAllocation the webhooks and crons run, so this view cannot
 * disagree with runtime behavior.
 *
 * Editing writes automation_policies rows via /api/automation/policies.
 * Voice campaigns are READ-ONLY v1: their allocation lives in voice_campaigns
 * columns (agent_type / live-transfer), edited in the Call Center.
 */

// ── Owner badge ──────────────────────────────────────────────────────

const OWNER_STYLES: Record<MatrixOwner, { label: string; cls: string; Icon: typeof Bot }> = {
  ai: { label: 'AI', cls: 'border-aurea-primary/30 bg-aurea-primary/10 text-aurea-primary', Icon: Bot },
  human: { label: 'Human', cls: 'border-aurea-amber/30 bg-aurea-amber/10 text-aurea-amber', Icon: User },
  hybrid: { label: 'Hybrid', cls: 'border-aurea-gold/40 bg-aurea-gold/10 text-aurea-gold', Icon: CalendarClock },
  hold: { label: 'Hold + SLA', cls: 'border-aurea-border bg-aurea-surface-2 text-aurea-ink-2', Icon: Clock },
}

export function OwnerBadge({ owner, slaSeconds }: { owner: MatrixOwner; slaSeconds?: number | null }) {
  const s = OWNER_STYLES[owner]
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium ${s.cls}`}>
      <s.Icon className="h-3 w-3" strokeWidth={1.75} />
      {s.label}
      {owner === 'hold' && slaSeconds != null && (
        <span className="tabular-nums">· {Math.round(slaSeconds / 60)}m</span>
      )}
    </span>
  )
}

function EffectiveNow({ cell }: { cell: OwnerCell }) {
  if (cell.owner !== 'hybrid') return null
  return (
    <span
      className={`text-[10.5px] font-medium ${
        cell.effectiveNow === 'human' ? 'text-aurea-amber' : 'text-aurea-primary'
      }`}
    >
      Now: {cell.effectiveNow === 'human' ? 'Human' : 'AI'}
    </span>
  )
}

// ── Matrix ───────────────────────────────────────────────────────────

type EditorTarget =
  | { scope: 'org_default' }
  | { scope: 'campaign'; campaignId: string; name: string }
  | { scope: 'stage'; stageId: string; name: string }

export function OwnershipMatrix({
  settings,
  policies,
  campaigns,
  voiceCampaigns,
  stages,
  isAdmin,
  onPoliciesChanged,
}: {
  settings: AutomationSettings
  policies: AutomationPolicy[]
  campaigns: MatrixCampaign[]
  voiceCampaigns: MatrixVoiceCampaign[]
  stages: MatrixStage[]
  isAdmin: boolean
  onPoliciesChanged: () => Promise<void> | void
}) {
  const [editing, setEditing] = useState<EditorTarget | null>(null)

  const orgConfig: AllocationOrgConfig = {
    timezone: settings.timezone || 'America/New_York',
    human_first_sla_enabled: settings.human_first_sla_enabled ?? false,
    human_first_sla_seconds: settings.human_first_sla_seconds ?? 180,
  }

  const cellFor = (kind: AllocationKind, extra: { campaignId?: string; stageId?: string } = {}) =>
    deriveOwnerCell(policies, orgConfig, { organizationId: 'current', kind, ...extra })

  const findPolicy = (target: EditorTarget): AutomationPolicy | null => {
    if (target.scope === 'org_default') {
      return policies.find((p) => p.scope === 'org_default') ?? null
    }
    if (target.scope === 'campaign') {
      return policies.find((p) => p.scope === 'campaign' && p.campaign_id === target.campaignId) ?? null
    }
    return policies.find((p) => p.scope === 'stage' && p.stage_id === target.stageId) ?? null
  }

  const isEditing = (target: EditorTarget) =>
    editing != null &&
    editing.scope === target.scope &&
    (target.scope !== 'campaign' ||
      (editing as { campaignId?: string }).campaignId === target.campaignId) &&
    (target.scope !== 'stage' || (editing as { stageId?: string }).stageId === target.stageId)

  const editorRow = (target: EditorTarget, colSpan: number) =>
    isEditing(target) ? (
      <tr>
        <td colSpan={colSpan} className="bg-aurea-canvas px-3 py-3">
          <PolicyEditor
            target={target}
            existing={findPolicy(target)}
            onClose={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null)
              await onPoliciesChanged()
            }}
          />
        </td>
      </tr>
    ) : null

  const rowButton = (target: EditorTarget) =>
    isAdmin ? (
      <Button
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-2 text-[11px] text-aurea-ink-3"
        onClick={() => setEditing(isEditing(target) ? null : target)}
      >
        <Pencil className="h-3 w-3" strokeWidth={1.75} />
        Edit
      </Button>
    ) : null

  return (
    <section className="aurea-card p-5">
      <div className="mb-1 flex items-center gap-2">
        <Grid3x3 className="h-4 w-4 text-aurea-primary" strokeWidth={1.75} />
        <h2 className="text-[15px] font-semibold text-aurea-ink">Ownership matrix</h2>
      </div>
      <p className="mb-4 text-[12px] text-aurea-ink-2">
        Who acts on each kind of work. &ldquo;Hold + SLA&rdquo; means your team gets first crack and
        the AI only takes over after the response window expires.
        {!isAdmin && ' Editing is managed by your agency.'}
      </p>

      <div className="space-y-6">
        {/* Org-level defaults, one row per work kind */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-aurea-ink-3">
              Organization defaults
            </span>
            {rowButton({ scope: 'org_default' })}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead>
                <tr className="border-b border-aurea-border text-[10.5px] uppercase tracking-[0.08em] text-aurea-ink-3">
                  <th className="py-2 pr-3 font-semibold">Work</th>
                  <th className="py-2 pr-3 font-semibold">Owner</th>
                  <th className="py-2 pr-3 font-semibold">Decided by</th>
                  <th className="py-2 font-semibold">Effective now</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-aurea-border/60">
                {editorRow({ scope: 'org_default' }, 4)}
                {WORK_KINDS.map(({ kind, label, description }) => {
                  const cell = cellFor(kind)
                  return (
                    <tr key={kind}>
                      <td className="py-2 pr-3">
                        <span className="font-medium text-aurea-ink">{label}</span>
                        <span className="ml-2 hidden text-[11.5px] text-aurea-ink-3 lg:inline">
                          {description}
                        </span>
                      </td>
                      <td className="py-2 pr-3">
                        <OwnerBadge owner={cell.owner} slaSeconds={cell.slaSeconds} />
                      </td>
                      <td className="py-2 pr-3 text-aurea-ink-3">{cell.source}</td>
                      <td className="py-2">
                        <EffectiveNow cell={cell} />
                        {cell.owner !== 'hybrid' && (
                          <span className="text-[11px] text-aurea-ink-3">
                            {cell.effectiveNow === 'hold' ? 'Waiting on humans first' : '—'}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Per SMS/email campaign */}
        {campaigns.length > 0 && (
          <div>
            <span className="mb-2 block text-[10.5px] font-semibold uppercase tracking-[0.08em] text-aurea-ink-3">
              Campaigns (SMS / Email)
            </span>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[12.5px]">
                <tbody className="divide-y divide-aurea-border/60">
                  {campaigns.map((c) => {
                    const target: EditorTarget = { scope: 'campaign', campaignId: c.id, name: c.name }
                    const cell = cellFor('nurture_step', { campaignId: c.id })
                    return (
                      <FragmentRow key={c.id}>
                        <tr>
                          <td className="w-2/5 py-2 pr-3">
                            <span className="font-medium text-aurea-ink">{c.name}</span>
                            <span className="ml-2 text-[11px] uppercase text-aurea-ink-3">
                              {c.channel} · {c.status}
                            </span>
                          </td>
                          <td className="py-2 pr-3">
                            <OwnerBadge owner={cell.owner} slaSeconds={cell.slaSeconds} />
                          </td>
                          <td className="py-2 pr-3 text-aurea-ink-3">{cell.source}</td>
                          <td className="py-2 pr-3">
                            <EffectiveNow cell={cell} />
                          </td>
                          <td className="py-2 text-right">{rowButton(target)}</td>
                        </tr>
                        {editorRow(target, 5)}
                      </FragmentRow>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Voice campaigns — read-only v1 */}
        {voiceCampaigns.length > 0 && (
          <div>
            <span className="mb-2 block text-[10.5px] font-semibold uppercase tracking-[0.08em] text-aurea-ink-3">
              Voice campaigns
            </span>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[12.5px]">
                <tbody className="divide-y divide-aurea-border/60">
                  {voiceCampaigns.map((vc) => {
                    const derived = deriveVoiceOwner(vc)
                    return (
                      <tr key={vc.id}>
                        <td className="w-2/5 py-2 pr-3">
                          <span className="font-medium text-aurea-ink">{vc.name}</span>
                          <span className="ml-2 text-[11px] uppercase text-aurea-ink-3">{vc.status}</span>
                        </td>
                        <td className="py-2 pr-3">
                          <OwnerBadge owner={derived.owner} />
                        </td>
                        <td className="py-2 pr-3 text-aurea-ink-3">{derived.label}</td>
                        <td className="py-2 text-right">
                          <Link
                            href="/call-center"
                            className="inline-flex items-center gap-1 text-[11px] text-aurea-ink-3 hover:text-aurea-ink"
                          >
                            Edit in Call Center <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
                          </Link>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-1.5 text-[11px] text-aurea-ink-3">
              Voice allocation lives on the campaign itself (agent type + live transfer), so
              these rows are read-only here.
            </p>
          </div>
        )}

        {/* Per pipeline stage */}
        {stages.length > 0 && (
          <div>
            <span className="mb-2 block text-[10.5px] font-semibold uppercase tracking-[0.08em] text-aurea-ink-3">
              Pipeline stages
            </span>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[12.5px]">
                <tbody className="divide-y divide-aurea-border/60">
                  {stages.map((s) => {
                    const target: EditorTarget = { scope: 'stage', stageId: s.id, name: s.name }
                    const cell = cellFor('stage_automation', { stageId: s.id })
                    return (
                      <FragmentRow key={s.id}>
                        <tr>
                          <td className="w-2/5 py-2 pr-3">
                            <span className="mr-2 inline-block h-2 w-2 rounded-full align-middle" style={{ backgroundColor: s.color }} />
                            <span className="font-medium text-aurea-ink">{s.name}</span>
                          </td>
                          <td className="py-2 pr-3">
                            <OwnerBadge owner={cell.owner} slaSeconds={cell.slaSeconds} />
                          </td>
                          <td className="py-2 pr-3 text-aurea-ink-3">{cell.source}</td>
                          <td className="py-2 pr-3">
                            <EffectiveNow cell={cell} />
                          </td>
                          <td className="py-2 text-right">{rowButton(target)}</td>
                        </tr>
                        {editorRow(target, 5)}
                      </FragmentRow>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

/** tbody fragments need a keyed wrapper that renders nothing extra. */
function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

// ── Policy editor ────────────────────────────────────────────────────

const DAY_KEYS: Array<keyof WeekSchedule> = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]

const DEFAULT_HUMAN_SCHEDULE: WeekSchedule = {
  sunday: { enabled: false, start: 9, end: 17 },
  monday: { enabled: true, start: 9, end: 17 },
  tuesday: { enabled: true, start: 9, end: 17 },
  wednesday: { enabled: true, start: 9, end: 17 },
  thursday: { enabled: true, start: 9, end: 17 },
  friday: { enabled: true, start: 9, end: 17 },
  saturday: { enabled: false, start: 9, end: 17 },
}

function PolicyEditor({
  target,
  existing,
  onSaved,
  onClose,
}: {
  target: EditorTarget
  existing: AutomationPolicy | null
  onSaved: () => Promise<void> | void
  onClose: () => void
}) {
  const [owner, setOwner] = useState<'ai' | 'human' | 'hybrid'>(existing?.owner ?? 'ai')
  const [aiRole, setAiRole] = useState<'setter' | 'closer' | ''>(existing?.ai_role ?? '')
  const [humanFirst, setHumanFirst] = useState(existing?.human_first ?? false)
  const [slaSeconds, setSlaSeconds] = useState(existing?.human_response_sla_seconds ?? 180)
  const [kinds, setKinds] = useState<string[]>(existing?.kinds ?? [])
  const [schedule, setSchedule] = useState<WeekSchedule>(
    (existing?.human_schedule as WeekSchedule | null) ?? DEFAULT_HUMAN_SCHEDULE
  )
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)

  const title =
    target.scope === 'org_default'
      ? 'Org default policy'
      : `Policy for ${'name' in target ? target.name : ''}`

  const toggleKind = (kind: string) =>
    setKinds((prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]))

  async function save() {
    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        scope: target.scope,
        owner,
        ai_role: aiRole || null,
        human_first: humanFirst,
        human_response_sla_seconds: slaSeconds,
        kinds,
        human_schedule: owner === 'hybrid' ? schedule : null,
        enabled: true,
      }
      if (target.scope === 'campaign') body.campaign_id = target.campaignId
      if (target.scope === 'stage') body.stage_id = target.stageId

      const res = await fetch('/api/automation/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(json?.error || 'Save failed')
      toast.success('Policy saved')
      await onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save policy')
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!existing) return
    setRemoving(true)
    try {
      const res = await fetch(`/api/automation/policies?id=${existing.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Delete failed')
      toast.success('Policy removed — falls back to the default')
      await onSaved()
    } catch {
      toast.error('Failed to remove policy')
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-aurea-border bg-aurea-surface p-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-aurea-ink">{title}</span>
        <span className="text-[11px] text-aurea-ink-3">
          {existing ? 'Editing existing policy' : 'Creating a new policy'}
        </span>
      </div>

      {/* Owner */}
      <div className="flex flex-wrap items-center gap-4">
        <div>
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-aurea-ink-3">
            Owner
          </div>
          <div className="inline-flex overflow-hidden rounded-lg border border-aurea-border">
            {(['ai', 'human', 'hybrid'] as const).map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => setOwner(o)}
                className={`px-3 py-1.5 text-[12px] font-medium capitalize transition-colors ${
                  owner === o
                    ? 'bg-aurea-ink text-aurea-canvas'
                    : 'text-aurea-ink-3 hover:bg-aurea-surface-2 hover:text-aurea-ink'
                }`}
              >
                {o === 'ai' ? 'AI' : o}
              </button>
            ))}
          </div>
        </div>

        {/* AI role */}
        <div>
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-aurea-ink-3">
            AI role
          </div>
          <div className="inline-flex overflow-hidden rounded-lg border border-aurea-border">
            {([
              ['', 'Auto'],
              ['setter', 'Setter'],
              ['closer', 'Closer'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setAiRole(value)}
                className={`px-3 py-1.5 text-[12px] font-medium transition-colors ${
                  aiRole === value
                    ? 'bg-aurea-ink text-aurea-canvas'
                    : 'text-aurea-ink-3 hover:bg-aurea-surface-2 hover:text-aurea-ink'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Human-first hold */}
        <div>
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-aurea-ink-3">
            Human first (hold + SLA)
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={humanFirst} onCheckedChange={(v) => setHumanFirst(!!v)} />
            {humanFirst && (
              <label className="flex items-center gap-1 text-[12px] text-aurea-ink-2">
                <input
                  type="number"
                  min={30}
                  max={3600}
                  value={slaSeconds}
                  onChange={(e) => setSlaSeconds(Number(e.target.value))}
                  className="w-20 rounded border border-aurea-border bg-aurea-canvas px-1.5 py-1 text-[12px] tabular-nums"
                />
                seconds before AI takes over
              </label>
            )}
          </div>
        </div>
      </div>

      {/* Kinds */}
      <div>
        <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-aurea-ink-3">
          Applies to
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setKinds([])}
            className={`rounded border px-2 py-0.5 text-[11.5px] font-medium transition-colors ${
              kinds.length === 0
                ? 'border-aurea-primary/40 bg-aurea-primary/10 text-aurea-primary'
                : 'border-aurea-border text-aurea-ink-3 hover:text-aurea-ink'
            }`}
          >
            All kinds
          </button>
          {WORK_KINDS.map(({ kind, label }) => (
            <button
              key={kind}
              type="button"
              onClick={() => toggleKind(kind)}
              className={`rounded border px-2 py-0.5 text-[11.5px] font-medium transition-colors ${
                kinds.includes(kind)
                  ? 'border-aurea-primary/40 bg-aurea-primary/10 text-aurea-primary'
                  : 'border-aurea-border text-aurea-ink-3 hover:text-aurea-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Hybrid week schedule (enabled hours = HUMAN hours) */}
      {owner === 'hybrid' && (
        <div>
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-aurea-ink-3">
            Human hours (outside them, the AI owns)
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
            {DAY_KEYS.map((day) => {
              const d = schedule[day]
              return (
                <div
                  key={day}
                  className="flex items-center gap-2 rounded border border-aurea-border bg-aurea-canvas px-2 py-1.5"
                >
                  <Switch
                    size="sm"
                    checked={d.enabled}
                    onCheckedChange={(v) =>
                      setSchedule((prev) => ({ ...prev, [day]: { ...prev[day], enabled: !!v } }))
                    }
                  />
                  <span className="w-9 text-[11.5px] font-medium capitalize text-aurea-ink-2">
                    {day.slice(0, 3)}
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={23}
                    disabled={!d.enabled}
                    value={d.start}
                    onChange={(e) =>
                      setSchedule((prev) => ({
                        ...prev,
                        [day]: { ...prev[day], start: Number(e.target.value) },
                      }))
                    }
                    className="w-12 rounded border border-aurea-border bg-aurea-surface px-1 py-0.5 text-[11.5px] tabular-nums disabled:opacity-40"
                  />
                  <span className="text-[11px] text-aurea-ink-3">to</span>
                  <input
                    type="number"
                    min={1}
                    max={24}
                    disabled={!d.enabled}
                    value={d.end}
                    onChange={(e) =>
                      setSchedule((prev) => ({
                        ...prev,
                        [day]: { ...prev[day], end: Number(e.target.value) },
                      }))
                    }
                    className="w-12 rounded border border-aurea-border bg-aurea-surface px-1 py-0.5 text-[11.5px] tabular-nums disabled:opacity-40"
                  />
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between border-t border-aurea-border pt-3">
        <div>
          {existing && (
            <Button
              variant="ghost"
              size="sm"
              onClick={remove}
              disabled={removing || saving}
              className="gap-1.5 text-aurea-rose hover:text-aurea-rose"
            >
              {removing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" strokeWidth={1.75} />}
              Remove policy
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving || removing}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={saving || removing} className="gap-1.5">
            {saving && <Loader2 className="h-3 w-3 animate-spin" />}
            Save policy
          </Button>
        </div>
      </div>
    </div>
  )
}
