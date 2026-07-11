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
type Direction = 'in' | 'out'

// Inbound replies are one kind; outbound touches (speed-to-lead + nurture
// follow-ups) are grouped so a single "outbound owner" choice covers both.
const INBOUND_KINDS = ['inbound_reply']
const OUTBOUND_KINDS = ['speed_to_lead', 'nurture_step']

const OWNER_LABELS: Record<AutomationPolicyOwner, string> = {
  ai: 'AI',
  human: 'Human',
  hybrid: 'Hybrid',
}

function findPolicy(
  policies: AutomationPolicy[],
  scope: 'stage' | 'campaign',
  targetId: string,
  dir: Direction
) {
  const kind = dir === 'in' ? 'inbound_reply' : 'speed_to_lead'
  return policies.find(
    (p) =>
      p.scope === scope &&
      (scope === 'stage' ? p.stage_id === targetId : p.campaign_id === targetId) &&
      (p.kinds.length === 0 || p.kinds.includes(kind))
  )
}

/**
 * Per-stage / per-campaign overrides for who handles inbound replies and
 * outbound (speed-to-lead + nurture) touches — AI, human, or hybrid. Backed
 * by the CRUD API at /api/automation/policies. Cells left on "global" defer
 * to the org-wide autopilot settings above.
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

  async function upsert(scope: 'stage' | 'campaign', targetId: string, dir: Direction, owner: AutomationPolicyOwner) {
    const key = `${scope}:${targetId}:${dir}`
    const existing = findPolicy(policies, scope, targetId, dir)
    const payload = {
      scope,
      kinds: dir === 'in' ? INBOUND_KINDS : OUTBOUND_KINDS,
      owner,
      stage_id: scope === 'stage' ? targetId : null,
      campaign_id: scope === 'campaign' ? targetId : null,
      ...(existing ? { id: existing.id } : {}),
    }

    setPendingKey(key)
    try {
      const res = await fetch('/api/automation/policies', {
        method: existing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        toast.error(body.error || 'Failed to save automation policy')
        return
      }
      const { policy } = await res.json()
      setPolicies((prev) =>
        existing ? prev.map((p) => (p.id === policy.id ? policy : p)) : [...prev, policy]
      )
    } catch {
      toast.error('Failed to save automation policy')
    } finally {
      setPendingKey(null)
    }
  }

  function ownerCell(scope: 'stage' | 'campaign', targetId: string, dir: Direction) {
    const key = `${scope}:${targetId}:${dir}`
    const policy = findPolicy(policies, scope, targetId, dir)
    const value = policy?.owner ?? 'global'
    return (
      <Select
        items={{ global: '— Global (AI)', ai: 'AI', human: 'Human', hybrid: 'Hybrid' }}
        value={value}
        onValueChange={(v) => v && v !== 'global' && upsert(scope, targetId, dir, v as AutomationPolicyOwner)}
        disabled={!isAdmin || pendingKey === key}
      >
        <SelectTrigger className="h-8 w-full text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="global">— Global (AI)</SelectItem>
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
          <div className="grid grid-cols-[1.6fr_1fr_1fr] gap-2 border-b border-aurea-border bg-aurea-surface-2 px-3 py-2 aurea-eyebrow font-normal">
            <span>{scope === 'stage' ? 'Stage' : 'Campaign'}</span>
            <span>Inbound owner</span>
            <span>Outbound owner</span>
          </div>
          {rows.map((r) => (
            <div
              key={r.id}
              className="grid grid-cols-[1.6fr_1fr_1fr] items-center gap-2 border-b border-aurea-border px-3 py-2 last:border-0"
            >
              <span className="truncate text-[13px] text-aurea-ink">{r.name}</span>
              {ownerCell(scope, r.id, 'in')}
              {ownerCell(scope, r.id, 'out')}
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
            Override who handles a stage or campaign. Cells left on &ldquo;Global&rdquo; inherit the
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
