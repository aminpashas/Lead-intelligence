'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { TrendingUp, TrendingDown, ArrowLeftRight, ShieldOff, FileQuestion, Bot, Sparkles, Gauge } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDistanceToNow } from 'date-fns'

type Change = {
  id: string
  agent_id: string
  change_type: 'protocol_swap' | 'cap_increase' | 'cap_decrease' | 'autopilot_throttle' | 'protocol_proposed'
  triggered_by: 'auto_discipline' | 'auto_reward' | 'manual' | 'ab_test' | 'rollback'
  from_multiplier: number | null
  to_multiplier: number | null
  reason: string
  created_at: string
}

type Cap = {
  agent_id: string
  base_daily_cap: number
  multiplier: number
  autopilot_mode_override: 'auto' | 'review_first' | 'off' | null
  updated_at: string
}

type Agent = {
  id: string
  name: string
  role: 'setter' | 'closer'
}

type ApiResponse = { changes: Change[]; caps: Cap[]; agents: Agent[] }

const CHANGE_STYLES: Record<Change['change_type'], { icon: typeof TrendingUp; bg: string; text: string; label: string }> = {
  cap_increase: {
    icon: TrendingUp,
    bg: 'bg-aurea-primary/10 border-aurea-primary/20',
    text: 'text-aurea-primary',
    label: 'Reward · cap +',
  },
  cap_decrease: {
    icon: TrendingDown,
    bg: 'bg-aurea-rose/10 border-aurea-rose/20',
    text: 'text-aurea-rose',
    label: 'Discipline · cap −',
  },
  protocol_swap: {
    icon: ArrowLeftRight,
    bg: 'bg-aurea-surface-2 border-aurea-border',
    text: 'text-aurea-ink-2',
    label: 'Protocol swap',
  },
  protocol_proposed: {
    icon: FileQuestion,
    bg: 'bg-aurea-amber/10 border-aurea-amber/20',
    text: 'text-aurea-amber',
    label: 'Protocol proposed',
  },
  autopilot_throttle: {
    icon: ShieldOff,
    bg: 'bg-aurea-surface-2 border-aurea-border',
    text: 'text-aurea-ink-3',
    label: 'Autopilot throttle',
  },
}

export function ProtocolAuditView() {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/agents/protocol-changes?limit=100')
        if (!res.ok) throw new Error(`API ${res.status}`)
        setData(await res.json())
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const agentById = new Map((data?.agents ?? []).map((a) => [a.id, a]))
  const capByAgent = new Map((data?.caps ?? []).map((c) => [c.agent_id, c]))

  return (
    <div className="space-y-6 animate-in fade-in-0 duration-500">
      <div>
        <p className="aurea-eyebrow mb-3">Protocol Audit</p>
        <div className="flex items-center gap-2">
          <Gauge className="text-aurea-ink-3 h-[17px] w-[17px] strokeWidth={1.75}" />
          <h1 className="aurea-display text-[40px] text-aurea-ink">Agent Protocols & Discipline</h1>
        </div>
        <p className="text-[15px] text-aurea-ink-2 mt-2">
          Reward and discipline actions taken automatically after the weekly review. Cap multiplier adjusts lead allocation;
          protocol swaps activate alternate prompts when probation triggers.
        </p>
      </div>

      {error && (
        <Card>
          <CardContent className="p-4 text-sm text-aurea-rose">Error: {error}</CardContent>
        </Card>
      )}

      {loading && !data && <Skeleton className="h-64 w-full" />}

      {data && (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {data.agents.map((agent) => {
              const cap = capByAgent.get(agent.id)
              const RoleIcon = agent.role === 'setter' ? Sparkles : Bot
              const effectiveCap = cap ? Math.floor(cap.base_daily_cap * cap.multiplier) : null
              const multiplierDelta = cap ? cap.multiplier - 1.0 : 0
              return (
                <Card key={agent.id}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <RoleIcon className="text-aurea-ink-3 strokeWidth={1.75} h-[17px] w-[17px]" />
                      <span className="aurea-display text-[18px] text-aurea-ink">{agent.name}</span>
                    </CardTitle>
                    <CardDescription className="text-[12px] text-aurea-ink-3 capitalize">{agent.role}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-1.5">
                    <div className="flex items-baseline gap-2">
                      <span className="aurea-display text-[32px] tabular-nums text-aurea-ink">{effectiveCap ?? '—'}</span>
                      <span className="text-[12px] text-aurea-ink-3">leads/day cap</span>
                    </div>
                    <div className="text-[12px] text-aurea-ink-3">
                      Base {cap?.base_daily_cap ?? '—'} ×{' '}
                      <span className={cn('font-medium tabular-nums',
                        multiplierDelta > 0 ? 'text-aurea-primary' :
                        multiplierDelta < 0 ? 'text-aurea-rose' : ''
                      )}>
                        {cap?.multiplier.toFixed(2) ?? '—'}
                      </span>
                    </div>
                    {cap?.autopilot_mode_override && cap.autopilot_mode_override !== 'auto' && (
                      <Badge variant="outline" className="bg-aurea-amber/10 text-aurea-amber border-aurea-amber/20 text-[10px]">
                        Autopilot · {cap.autopilot_mode_override}
                      </Badge>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="aurea-display text-[22px] text-aurea-ink">Recent actions</CardTitle>
              <CardDescription className="text-[13px] text-aurea-ink-3">
                Audit trail of every reward, discipline, or protocol change. The discipline engine runs after the weekly review cron.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.changes.length === 0 ? (
                <div className="text-sm text-aurea-ink-2 py-4">
                  No actions yet. The first weekly review on Monday 03:00 UTC will populate this list.
                </div>
              ) : (
                <ul className="divide-y divide-aurea-border">
                  {data.changes.map((c) => {
                    const style = CHANGE_STYLES[c.change_type]
                    const Icon = style.icon
                    const agent = agentById.get(c.agent_id)
                    return (
                      <li key={c.id} className="py-3.5 flex items-start gap-3 border-b border-aurea-border last:border-0">
                        <div className={cn('rounded-full p-1.5 border', style.bg)}>
                          <Icon className={cn('h-3.5 w-3.5', style.text)} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-baseline gap-2">
                            <span className="text-[14px] font-medium text-aurea-ink">{agent?.name ?? 'Unknown agent'}</span>
                            <Badge variant="outline" className={cn('text-[10px]', style.bg, style.text)}>
                              {style.label}
                            </Badge>
                            <span className="text-[12px] text-aurea-ink-3 capitalize">
                              · {c.triggered_by.replace('_', ' ')}
                            </span>
                            <span className="font-mono text-[11px] text-aurea-ink-3 ml-auto">
                              {formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}
                            </span>
                          </div>
                          <p className="text-[12px] text-aurea-ink-2 mt-0.5">{c.reason}</p>
                          {c.from_multiplier !== null && c.to_multiplier !== null &&
                           c.from_multiplier !== c.to_multiplier && (
                            <div className="font-mono text-[11px] text-aurea-ink-3 mt-1 tabular-nums">
                              {c.from_multiplier.toFixed(2)} → {c.to_multiplier.toFixed(2)} multiplier
                            </div>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
