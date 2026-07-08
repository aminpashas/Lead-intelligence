'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Bot, Gauge, Sparkles, Settings2, ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { useOrgStore } from '@/lib/store/use-org'
import { isAdminRole } from '@/lib/auth/permissions'
import {
  KPI_DISPLAY_ORDER,
  KPI_LABELS,
  KPI_DESCRIPTIONS,
  KPI_UNITS,
  DISPLAY_ONLY_KPIS,
  formatKpiValue,
  kpiDirectionArrow,
  type KpiStatus,
} from '@/lib/agents/kpi-status'
import { AgentTargetsEditor } from './agent-targets-editor'
import { AgentStatusPill } from './agent-status-pill'
import { ManualOverrideDialog } from './manual-override-dialog'

type KpiCell = {
  value: number | null
  target: number | null
  warning: number | null
  critical: number | null
  direction: 'higher_is_better' | 'lower_is_better' | null
  status: KpiStatus
}

type AgentKpi = {
  id: string
  name: string
  role: 'setter' | 'closer'
  kpis: Record<string, KpiCell>
  raw: Record<string, number | null>
}

type ApiResponse = {
  agents: AgentKpi[]
  dateRange: { start: string; end: string }
}

const RANGE_PRESETS = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 12 months', days: 365 },
] as const

const RANGE_ITEMS: Record<string, string> = {
  ...Object.fromEntries(RANGE_PRESETS.map((p) => [String(p.days), p.label])),
  '0': 'Custom',
}

function defaultRange() {
  const end = new Date()
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000)
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  }
}

const STATUS_STYLES: Record<KpiStatus, { chip: string; ring: string; label: string }> = {
  green: {
    chip: 'bg-aurea-primary/10 text-aurea-primary border-aurea-primary/20',
    ring: 'ring-aurea-primary/20',
    label: 'On target',
  },
  yellow: {
    chip: 'bg-aurea-amber/10 text-aurea-amber border-aurea-amber/20',
    ring: 'ring-aurea-amber/20',
    label: 'Watch',
  },
  red: {
    chip: 'bg-aurea-rose/10 text-aurea-rose border-aurea-rose/20',
    ring: 'ring-aurea-rose/20',
    label: 'Below target',
  },
  no_target: {
    chip: 'bg-aurea-surface-2 text-aurea-ink-3 border-aurea-border',
    ring: '',
    label: '—',
  },
}

export function AgentScorecard() {
  const { userProfile } = useOrgStore()
  const canEditTargets = isAdminRole(userProfile?.role || 'member')

  const [range, setRange] = useState(defaultRange())
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null)
  const [overrideAgentId, setOverrideAgentId] = useState<string | null>(null)
  const [statusRefreshKey, setStatusRefreshKey] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        start: new Date(range.start).toISOString(),
        end: new Date(range.end + 'T23:59:59').toISOString(),
      })
      const res = await fetch(`/api/analytics/agent-kpi?${params}`)
      if (!res.ok) throw new Error(`API ${res.status}`)
      const json = (await res.json()) as ApiResponse
      setData(json)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load KPIs')
    } finally {
      setLoading(false)
    }
  }, [range])

  useEffect(() => {
    void load()
  }, [load])

  const setPreset = (days: number) => {
    const end = new Date()
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000)
    setRange({ start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) })
  }

  const activePreset = useMemo(() => {
    const endTime = new Date(range.end).getTime()
    const startTime = new Date(range.start).getTime()
    const days = Math.round((endTime - startTime) / (24 * 60 * 60 * 1000))
    return RANGE_PRESETS.find((p) => p.days === days)?.days ?? 0
  }, [range])

  return (
    <div className="space-y-6 animate-in fade-in-0 duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="aurea-eyebrow mb-3">Agent Performance</p>
          <div className="flex items-center gap-2">
            <Gauge className="text-aurea-ink-3 h-[17px] w-[17px]" strokeWidth={1.75} />
            <h1 className="aurea-display text-[40px] text-aurea-ink">Agent KPI Dashboard</h1>
          </div>
          <p className="text-[15px] text-aurea-ink-2 mt-2">
            Per-agent scorecard against target percentages. Green hits the target, yellow is a warning, red is below critical.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <Link
            href="/analytics/agents/protocols"
            className="text-xs text-aurea-ink-3 hover:text-aurea-ink inline-flex items-center gap-1 mr-1"
          >
            Protocols & discipline <ArrowRight className="h-3 w-3" />
          </Link>
          <Select items={RANGE_ITEMS} value={String(activePreset)} onValueChange={(v) => setPreset(Number(v))}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Range" />
            </SelectTrigger>
            <SelectContent>
              {RANGE_PRESETS.map((p) => (
                <SelectItem key={p.days} value={String(p.days)}>{p.label}</SelectItem>
              ))}
              {activePreset === 0 && <SelectItem value="0">Custom</SelectItem>}
            </SelectContent>
          </Select>
          <Input
            type="date"
            value={range.start}
            onChange={(e) => setRange({ ...range, start: e.target.value })}
            className="w-[150px]"
          />
          <Input
            type="date"
            value={range.end}
            onChange={(e) => setRange({ ...range, end: e.target.value })}
            className="w-[150px]"
          />
        </div>
      </div>

      {error && (
        <Card>
          <CardContent className="p-4 text-sm text-aurea-rose">Error loading KPIs: {error}</CardContent>
        </Card>
      )}

      {loading && !data && (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-[480px] w-full" />
          <Skeleton className="h-[480px] w-full" />
        </div>
      )}

      {data && (
        <div className="grid gap-4 md:grid-cols-2">
          {data.agents.map((agent) => (
            <AgentCard
              key={`${agent.id}-${statusRefreshKey}`}
              agent={agent}
              canEditTargets={canEditTargets}
              canOverride={canEditTargets}
              onEdit={() => setEditingAgentId(agent.id)}
              onOverride={() => setOverrideAgentId(agent.id)}
            />
          ))}
          {data.agents.length === 0 && (
            <Card>
              <CardContent className="p-6 text-sm text-muted-foreground">
                No active agents found for this organization.
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {editingAgentId && (
        <AgentTargetsEditor
          agentId={editingAgentId}
          agentName={data?.agents.find((a) => a.id === editingAgentId)?.name || 'Agent'}
          onClose={() => setEditingAgentId(null)}
          onSaved={() => {
            setEditingAgentId(null)
            void load()
          }}
        />
      )}

      {overrideAgentId && (
        <ManualOverrideDialog
          agentId={overrideAgentId}
          agentName={data?.agents.find((a) => a.id === overrideAgentId)?.name || 'Agent'}
          onClose={() => setOverrideAgentId(null)}
          onSaved={() => {
            setOverrideAgentId(null)
            // Bump the refresh key so AgentStatusPill re-fetches
            setStatusRefreshKey((k) => k + 1)
          }}
        />
      )}
    </div>
  )
}

function AgentCard({
  agent,
  canEditTargets,
  canOverride,
  onEdit,
  onOverride,
}: {
  agent: AgentKpi
  canEditTargets: boolean
  canOverride: boolean
  onEdit: () => void
  onOverride: () => void
}) {
  const roleIcon = agent.role === 'setter' ? Sparkles : Bot
  const RoleIcon = roleIcon

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b border-aurea-border bg-aurea-surface-2/50">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <CardTitle className="flex items-center gap-2">
              <RoleIcon className="text-aurea-ink-3 h-[17px] w-[17px]" strokeWidth={1.75} />
              <span className="aurea-display text-[22px]">{agent.name}</span>
            </CardTitle>
            <CardDescription className="mt-1">
              {agent.role === 'setter'
                ? 'Qualification & consultation booking'
                : 'Post-consultation, financing & close'}
            </CardDescription>
            <div className="mt-3">
              <AgentStatusPill
                agentId={agent.id}
                canOverride={canOverride}
                onOverrideClick={onOverride}
              />
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge variant="outline" className="capitalize">{agent.role}</Badge>
            {canEditTargets && (
              <Button variant="outline" size="icon" onClick={onEdit} aria-label="Edit targets">
                <Settings2 className="h-4 w-4" strokeWidth={1.75} />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid grid-cols-2 divide-x divide-y divide-aurea-border">
          {KPI_DISPLAY_ORDER.map((kpiName) => {
            const cell = agent.kpis[kpiName]
            if (!cell) return null
            return <KpiCell key={kpiName} name={kpiName} cell={cell} />
          })}
        </div>
      </CardContent>
    </Card>
  )
}

function KpiCell({ name, cell }: { name: string; cell: KpiCell }) {
  const unit = KPI_UNITS[name]
  const displayOnly = DISPLAY_ONLY_KPIS.has(name)
  const styles = STATUS_STYLES[cell.status]
  const arrow = kpiDirectionArrow(cell.direction)

  return (
    <div className={cn('p-4 transition-colors', cell.status === 'red' && 'bg-aurea-rose/5', cell.status === 'yellow' && 'bg-aurea-amber/5')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="aurea-eyebrow !text-[10px] truncate" title={KPI_DESCRIPTIONS[name]}>
            {KPI_LABELS[name]}
          </div>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className="aurea-display text-[28px] tabular-nums text-aurea-ink">
              {formatKpiValue(cell.value, unit)}
            </span>
            {arrow && (
              <span className="text-xs text-aurea-ink-3" aria-label="goal direction">{arrow}</span>
            )}
          </div>
        </div>
        {!displayOnly && (
          <Badge
            variant="outline"
            className={cn('text-[10px] px-1.5 py-0 h-5 shrink-0', styles.chip)}
          >
            {styles.label}
          </Badge>
        )}
      </div>
      {!displayOnly && cell.target !== null && (
        <div className="mt-1.5 text-[11px] text-aurea-ink-3">
          Target {formatKpiValue(cell.target, unit)}
          {cell.warning !== null && cell.critical !== null && (
            <>
              {' · '}
              Warn {formatKpiValue(cell.warning, unit)}
              {' · '}
              Crit {formatKpiValue(cell.critical, unit)}
            </>
          )}
        </div>
      )}
    </div>
  )
}
