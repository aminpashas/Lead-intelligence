'use client'

import { useState } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Layers } from 'lucide-react'
import { toast } from 'sonner'
import type { AutomationPolicy, AutomationPolicyOwner } from '@/types/database'

type Row = { id: string; name: string }
type Defaults = { confidence_threshold: number; active_hours_start: number; active_hours_end: number }

const OWNER_LABELS: Record<AutomationPolicyOwner, string> = {
  ai: 'AI',
  human: 'Human',
  hybrid: 'Hybrid',
}

// The table allows one policy row per (scope, target) — so a stage/campaign has
// a single owner covering all interaction kinds. Inbound-vs-outbound split is a
// follow-up (needs a schema change to allow per-kind rows).
function findPolicy(policies: AutomationPolicy[], scope: 'stage' | 'campaign', targetId: string) {
  return policies.find(
    (p) => p.scope === scope && (scope === 'stage' ? p.stage_id === targetId : p.campaign_id === targetId)
  )
}

/**
 * Per-stage / per-campaign override for who handles automation — AI, human, or
 * hybrid. Backed by the upsert CRUD API at /api/automation/policies. A row left
 * on "Global" (no policy) defers to the org-wide autopilot settings above;
 * choosing Global on a configured row deletes the override.
 */
export function ScopedAutomationGrid({
  stages,
  campaigns,
  policies: initialPolicies,
  globalDefaults,
  isAdmin,
}: {
  stages: Row[]
  campaigns: Row[]
  policies: AutomationPolicy[]
  globalDefaults: Defaults
  isAdmin: boolean
}) {
  const [policies, setPolicies] = useState(initialPolicies)
  const [pendingKey, setPendingKey] = useState<string | null>(null)

  async function setOwner(
    scope: 'stage' | 'campaign',
    targetId: string,
    choice: AutomationPolicyOwner | 'global'
  ) {
    const key = `${scope}:${targetId}`
    const existing = findPolicy(policies, scope, targetId)
    setPendingKey(key)
    try {
      if (choice === 'global') {
        // Revert to inheriting the org default: delete the policy row.
        if (!existing) return
        const res = await fetch(`/api/automation/policies?id=${existing.id}`, { method: 'DELETE' })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          toast.error(body.error || 'Failed to remove override')
          return
        }
        setPolicies((prev) => prev.filter((p) => p.id !== existing.id))
        return
      }

      const res = await fetch('/api/automation/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          owner: choice,
          stage_id: scope === 'stage' ? targetId : null,
          campaign_id: scope === 'campaign' ? targetId : null,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        toast.error(body.error || 'Failed to save override')
        return
      }
      const { policy } = await res.json()
      setPolicies((prev) => {
        const rest = prev.filter((p) => p.id !== policy.id)
        return [...rest, policy]
      })
    } catch {
      toast.error('Failed to save override')
    } finally {
      setPendingKey(null)
    }
  }

  function ownerCell(scope: 'stage' | 'campaign', targetId: string) {
    const key = `${scope}:${targetId}`
    const policy = findPolicy(policies, scope, targetId)
    const value = policy?.owner ?? 'global'
    return (
      <Select
        value={value}
        onValueChange={(v) => v && setOwner(scope, targetId, v as AutomationPolicyOwner | 'global')}
        disabled={!isAdmin || pendingKey === key}
      >
        <SelectTrigger className="h-8 w-full text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="global">— Global (inherit)</SelectItem>
          {(Object.keys(OWNER_LABELS) as AutomationPolicyOwner[]).map((o) => (
            <SelectItem key={o} value={o}>
              {OWNER_LABELS[o]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }

  function section(label: string, rows: Row[], scope: 'stage' | 'campaign') {
    return (
      <div className="space-y-2">
        <h3 className="text-[13px] font-medium text-aurea-ink">{label}</h3>
        <div className="overflow-hidden rounded-lg border border-aurea-border">
          <div className="grid grid-cols-[2fr_1fr] gap-2 border-b border-aurea-border bg-aurea-surface-2 px-3 py-2 aurea-eyebrow font-normal">
            <span>{scope === 'stage' ? 'Stage' : 'Campaign'}</span>
            <span>Who handles it</span>
          </div>
          {rows.map((r) => (
            <div
              key={r.id}
              className="grid grid-cols-[2fr_1fr] items-center gap-2 border-b border-aurea-border px-3 py-2 last:border-0"
            >
              <span className="truncate text-[13px] text-aurea-ink">{r.name}</span>
              {ownerCell(scope, r.id)}
            </div>
          ))}
          {rows.length === 0 && (
            <div className="px-3 py-4 text-center text-[12.5px] text-aurea-ink-3">
              Nothing to configure yet.
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="aurea-card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-aurea-border px-5 py-4">
        <Layers className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
        <div>
          <h2 className="aurea-display text-[18px] text-aurea-ink">Scoped Automation</h2>
          <p className="text-[12px] text-aurea-ink-3">
            Override who handles a stage or campaign. Rows left on &ldquo;Global&rdquo; inherit the
            settings above (confidence {Math.round(globalDefaults.confidence_threshold * 100)}%, hours{' '}
            {globalDefaults.active_hours_start}:00–{globalDefaults.active_hours_end}:00).
          </p>
        </div>
      </div>
      <div className="space-y-5 p-5">
        {section('By stage', stages, 'stage')}
        {section('By campaign', campaigns, 'campaign')}
      </div>
    </div>
  )
}
