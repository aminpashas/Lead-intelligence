'use client'

import { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Users,
  DollarSign,
  AlertTriangle,
  Zap,
  Phone,
  Mail,
  MessageSquare,
  Target,
  TrendingUp,
  Shield,
  ArrowRight,
  CheckCircle2,
  XCircle,
  Timer,
  Flame,
} from 'lucide-react'
import { FUNNEL_STAGES, getStageUrgencyColor, getIntensityBadge } from '@/lib/funnel/stages'
import type { FunnelStageStrategy } from '@/lib/funnel/stages'
import type { PipelineStage } from '@/types/database'

type StageMetrics = {
  count: number
  totalValue: number
  avgDaysInStage: number
  noResponseCount: number
  noShowCount: number
  hotLeads: number
}

export function FunnelPlaybook({
  stages,
  stageMetrics,
  totalPipelineValue,
  totalLeads,
}: {
  stages: PipelineStage[]
  stageMetrics: Record<string, StageMetrics>
  totalPipelineValue: number
  totalLeads: number
}) {
  const [expandedStage, setExpandedStage] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<Record<string, string>>({})

  const toggleStage = (slug: string) => {
    setExpandedStage(expandedStage === slug ? null : slug)
  }

  const getTabForStage = (slug: string) => activeTab[slug] || 'strategy'

  const setTabForStage = (slug: string, tab: string) => {
    setActiveTab((prev) => ({ ...prev, [slug]: tab }))
  }

  return (
    <div className="space-y-5">
      {/* Pipeline Overview Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="aurea-card p-4">
          <div className="flex items-center justify-between">
            <p className="aurea-eyebrow">Total Leads</p>
            <Users className="h-[15px] w-[15px] text-aurea-ink-3" strokeWidth={1.75} />
          </div>
          <p className="mt-3 aurea-display text-[26px] tabular-nums text-aurea-ink">
            {totalLeads}
          </p>
        </div>
        <div className="aurea-card p-4">
          <div className="flex items-center justify-between">
            <p className="aurea-eyebrow">Pipeline Value</p>
            <DollarSign className="h-[15px] w-[15px] text-aurea-ink-3" strokeWidth={1.75} />
          </div>
          <p className="mt-3 aurea-display text-[26px] tabular-nums text-aurea-ink">
            ${totalPipelineValue.toLocaleString()}
          </p>
        </div>
        <div className="aurea-card p-4">
          <div className="flex items-center justify-between">
            <p className="aurea-eyebrow">Active Stages</p>
            <Target className="h-[15px] w-[15px] text-aurea-ink-3" strokeWidth={1.75} />
          </div>
          <p className="mt-3 aurea-display text-[26px] tabular-nums text-aurea-ink">
            {stages.filter((s) => !s.is_won && !s.is_lost).length}
          </p>
        </div>
        <div className="aurea-card p-4">
          <div className="flex items-center justify-between">
            <p className="aurea-eyebrow">Automations</p>
            <Zap className="h-[15px] w-[15px] text-aurea-ink-3" strokeWidth={1.75} />
          </div>
          <p className="mt-3 aurea-display text-[26px] tabular-nums text-aurea-ink">
            {FUNNEL_STAGES.reduce((sum, s) => sum + s.entryActions.length + s.engagementRules.length, 0)}
          </p>
        </div>
      </div>

      {/* Visual Funnel */}
      <div className="aurea-card overflow-hidden">
        <div className="border-b border-aurea-border px-5 py-4">
          <h2 className="aurea-display text-[22px] text-aurea-ink">Conversion Funnel</h2>
        </div>
        <div className="space-y-2 px-5 py-4">
          {FUNNEL_STAGES.filter((s) => s.slug !== 'lost').map((stage, idx) => {
            const metrics = stageMetrics[stage.slug]
            const count = metrics?.count || 0
            const maxCount = Math.max(...Object.values(stageMetrics).map((m) => m.count), 1)
            const widthPct = Math.max(20, (count / maxCount) * 100)

            return (
              <div key={stage.slug} className="flex items-center gap-3">
                <div className="w-40 text-[12px] text-right truncate text-aurea-ink-2">{stage.name}</div>
                <div className="flex-1 relative">
                  <div
                    className="h-8 rounded-sm flex items-center px-3 bg-aurea-surface-2 border-l-2 border-aurea-primary transition-all"
                    style={{ width: `${widthPct}%` }}
                  >
                    <span className="text-[11px] font-mono tabular-nums text-aurea-ink-2">
                      {count} leads
                    </span>
                    {metrics?.totalValue > 0 && (
                      <span className="text-[11px] font-mono tabular-nums text-aurea-ink-3 ml-auto">
                        ${metrics.totalValue.toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>
                {idx < FUNNEL_STAGES.filter((s) => s.slug !== 'lost').length - 1 && (
                  <div className="w-6 flex justify-center">
                    <ArrowRight className="h-3 w-3 text-aurea-ink-3" strokeWidth={1.75} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Stage-by-Stage Playbook */}
      <div className="space-y-3">
        <p className="aurea-eyebrow">Stage Playbook</p>

        {FUNNEL_STAGES.map((stage) => {
          const isExpanded = expandedStage === stage.slug
          const metrics = stageMetrics[stage.slug]
          const intensityBadge = getIntensityBadge(stage.engagementIntensity)
          const urgencyClass = getStageUrgencyColor(stage.urgency)
          const tab = getTabForStage(stage.slug)

          return (
            <div key={stage.slug} className="aurea-card overflow-hidden">
              {/* Stage Header */}
              <button
                onClick={() => toggleStage(stage.slug)}
                className="w-full flex items-center gap-4 p-4 hover:bg-aurea-surface-2 transition-colors text-left"
              >
                <div className="w-1 h-10 rounded-full flex-shrink-0 bg-aurea-primary" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-[14px] font-semibold text-aurea-ink">{stage.name}</h3>
                    <span className={`text-[11px] px-2 py-0.5 rounded-sm font-medium ${intensityBadge.color}`}>
                      {intensityBadge.label}
                    </span>
                    <span className={`text-[11px] px-2 py-0.5 rounded-sm font-medium ${urgencyClass}`}>
                      {stage.urgency.charAt(0).toUpperCase() + stage.urgency.slice(1)} Priority
                    </span>
                    {stage.maxDaysInStage && (
                      <span className="text-[11px] text-aurea-ink-3 flex items-center gap-1">
                        <Timer className="h-3 w-3" strokeWidth={1.75} />
                        Max {stage.maxDaysInStage}d
                      </span>
                    )}
                  </div>
                  <p className="text-[12px] text-aurea-ink-3 mt-0.5">{stage.goal}</p>
                </div>

                {/* Stage Metrics */}
                <div className="flex items-center gap-4 flex-shrink-0 text-[13px]">
                  {metrics && (
                    <>
                      <div className="text-center">
                        <div className="font-mono tabular-nums font-semibold text-aurea-ink">{metrics.count}</div>
                        <div className="text-[10px] text-aurea-ink-3">Leads</div>
                      </div>
                      {metrics.totalValue > 0 && (
                        <div className="text-center">
                          <div className="font-mono tabular-nums font-semibold text-aurea-ink">
                            ${(metrics.totalValue / 1000).toFixed(0)}k
                          </div>
                          <div className="text-[10px] text-aurea-ink-3">Value</div>
                        </div>
                      )}
                      {metrics.hotLeads > 0 && (
                        <div className="text-center">
                          <div className="font-mono tabular-nums font-semibold text-aurea-rose flex items-center gap-1">
                            <Flame className="h-3 w-3" strokeWidth={1.75} />{metrics.hotLeads}
                          </div>
                          <div className="text-[10px] text-aurea-ink-3">Hot</div>
                        </div>
                      )}
                      {metrics.noResponseCount > 0 && (
                        <div className="text-center">
                          <div className="font-mono tabular-nums font-semibold text-aurea-amber">
                            {metrics.noResponseCount}
                          </div>
                          <div className="text-[10px] text-aurea-ink-3">No Reply</div>
                        </div>
                      )}
                    </>
                  )}
                  {isExpanded
                    ? <ChevronDown className="h-4 w-4 text-aurea-ink-3" strokeWidth={1.75} />
                    : <ChevronRight className="h-4 w-4 text-aurea-ink-3" strokeWidth={1.75} />}
                </div>
              </button>

              {/* Expanded Content */}
              {isExpanded && (
                <div className="border-t border-aurea-border">
                  {/* Tabs */}
                  <div className="flex border-b border-aurea-border px-4">
                    {[
                      { id: 'strategy', label: 'Sales Strategy', icon: Target },
                      { id: 'automation', label: 'Automations', icon: Zap },
                      { id: 'engagement', label: 'Engagement Rules', icon: MessageSquare },
                      { id: 'escalation', label: 'Escalation', icon: AlertTriangle },
                      { id: 'kpis', label: 'KPIs', icon: TrendingUp },
                    ].map((t) => (
                      <button
                        key={t.id}
                        onClick={() => setTabForStage(stage.slug, t.id)}
                        className={`flex items-center gap-1.5 px-4 py-2.5 text-[12px] font-medium border-b-2 transition-colors ${
                          tab === t.id
                            ? 'border-aurea-primary text-aurea-primary'
                            : 'border-transparent text-aurea-ink-3 hover:text-aurea-ink'
                        }`}
                      >
                        <t.icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                        {t.label}
                      </button>
                    ))}
                  </div>

                  <div className="p-5">
                    {tab === 'strategy' && <SalesStrategyTab stage={stage} />}
                    {tab === 'automation' && <AutomationsTab stage={stage} />}
                    {tab === 'engagement' && <EngagementTab stage={stage} />}
                    {tab === 'escalation' && <EscalationTab stage={stage} />}
                    {tab === 'kpis' && <KPIsTab stage={stage} />}
                  </div>

                  {/* Stage Transitions */}
                  <div className="border-t border-aurea-border px-5 py-3 bg-aurea-surface-2 flex items-center gap-4 text-[12px]">
                    <div className="flex items-center gap-1.5">
                      <CheckCircle2 className="h-4 w-4 text-aurea-primary" strokeWidth={1.75} />
                      <span className="text-aurea-ink-3">Success:</span>
                      <span className="font-medium text-aurea-ink">{stage.successTransition}</span>
                    </div>
                    {stage.failureTransitions.length > 0 && (
                      <div className="flex items-center gap-1.5">
                        <XCircle className="h-4 w-4 text-aurea-rose" strokeWidth={1.75} />
                        <span className="text-aurea-ink-3">Failure:</span>
                        <span className="font-medium text-aurea-ink">{stage.failureTransitions.join(', ')}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────

function SalesStrategyTab({ stage }: { stage: FunnelStageStrategy }) {
  return (
    <div className="space-y-6">
      {stage.salesStrategies.map((strategy, idx) => (
        <div key={idx} className="space-y-3">
          <div>
            <h4 className="text-[14px] font-semibold text-aurea-ink flex items-center gap-2">
              <Shield className="h-4 w-4 text-aurea-primary" strokeWidth={1.75} />
              {strategy.name}
            </h4>
            <p className="text-[13px] text-aurea-ink-2 mt-1">{strategy.description}</p>
          </div>

          {/* Talk Track */}
          <div className="bg-aurea-surface-2 border border-aurea-border rounded-sm p-4">
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-aurea-ink-2 mb-2">
              <MessageSquare className="h-3.5 w-3.5 text-aurea-primary" strokeWidth={1.75} />
              Talk Track
            </div>
            <p className="text-[13px] italic text-aurea-ink-2">&ldquo;{strategy.talkTrack}&rdquo;</p>
          </div>

          {/* Objection Handlers */}
          {strategy.objectionHandlers.length > 0 && (
            <div className="space-y-2">
              <h5 className="text-[12px] font-medium text-aurea-ink flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 text-aurea-amber" strokeWidth={1.75} />
                Objection Handlers
              </h5>
              {strategy.objectionHandlers.map((oh, ohIdx) => (
                <div key={ohIdx} className="bg-aurea-surface-2 border border-aurea-border rounded-sm p-3 space-y-2">
                  <div className="flex items-start gap-2">
                    <span className="text-aurea-rose font-semibold text-[10.5px] uppercase tracking-wide mt-0.5 shrink-0">
                      Objection:
                    </span>
                    <p className="text-[13px] text-aurea-ink-2">&ldquo;{oh.objection}&rdquo;</p>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-aurea-primary font-semibold text-[10.5px] uppercase tracking-wide mt-0.5 shrink-0">
                      Response:
                    </span>
                    <p className="text-[13px] text-aurea-ink-2">&ldquo;{oh.response}&rdquo;</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function AutomationsTab({ stage }: { stage: FunnelStageStrategy }) {
  return (
    <div className="space-y-4">
      <h4 className="text-[14px] font-semibold text-aurea-ink">
        When a lead enters &ldquo;{stage.name}&rdquo;
      </h4>
      <div className="space-y-2">
        {stage.entryActions.map((action, idx) => (
          <div key={idx} className="flex items-start gap-3 p-3 bg-aurea-surface-2 border border-aurea-border rounded-sm">
            <div className="mt-0.5 shrink-0">
              {action.type === 'sms' && <MessageSquare className="h-4 w-4 text-aurea-primary" strokeWidth={1.75} />}
              {action.type === 'email' && <Mail className="h-4 w-4 text-aurea-ink-2" strokeWidth={1.75} />}
              {action.type === 'task' && <CheckCircle2 className="h-4 w-4 text-aurea-ink-2" strokeWidth={1.75} />}
              {action.type === 'notification' && <AlertTriangle className="h-4 w-4 text-aurea-amber" strokeWidth={1.75} />}
              {action.type === 'ai_score' && <Zap className="h-4 w-4 text-aurea-primary" strokeWidth={1.75} />}
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="aurea-eyebrow">
                  {action.type.replace('_', ' ')}
                </span>
                <span className="font-mono text-[11px] text-aurea-ink-3">
                  {action.delay_minutes === 0
                    ? 'Immediately'
                    : action.delay_minutes < 60
                      ? `After ${action.delay_minutes}m`
                      : action.delay_minutes < 1440
                        ? `After ${Math.round(action.delay_minutes / 60)}h`
                        : `After ${Math.round(action.delay_minutes / 1440)}d`}
                </span>
              </div>
              <p className="text-[13px] text-aurea-ink-2 mt-0.5">{action.description}</p>
              {action.template && (
                <div className="mt-2 p-2 bg-aurea-canvas border border-aurea-border rounded-sm text-[11px] font-mono text-aurea-ink-3">
                  {action.template}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function EngagementTab({ stage }: { stage: FunnelStageStrategy }) {
  return (
    <div className="space-y-3">
      {stage.engagementRules.map((rule, idx) => (
        <div key={idx} className="flex items-start gap-3 p-4 bg-aurea-surface-2 border border-aurea-border rounded-sm">
          <div className="mt-0.5 shrink-0">
            {rule.channel === 'sms' && <MessageSquare className="h-4 w-4 text-aurea-primary" strokeWidth={1.75} />}
            {rule.channel === 'email' && <Mail className="h-4 w-4 text-aurea-ink-2" strokeWidth={1.75} />}
            {rule.channel === 'call' && <Phone className="h-4 w-4 text-aurea-ink-2" strokeWidth={1.75} />}
            {rule.channel === 'multi' && <Zap className="h-4 w-4 text-aurea-primary" strokeWidth={1.75} />}
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="aurea-eyebrow">
                {rule.channel}
              </span>
              <span className="text-[11px] text-aurea-ink-3">{rule.frequency}</span>
              {rule.aiPersonalize && (
                <span className="text-[11px] px-2 py-0.5 rounded-sm bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20">
                  AI Personalized
                </span>
              )}
            </div>
            <p className="text-[13px] text-aurea-ink-2 mt-1.5">{rule.description}</p>
            <div className="flex items-center gap-1 text-[11px] font-mono text-aurea-ink-3 mt-1">
              <Clock className="h-3 w-3" strokeWidth={1.75} />
              {rule.timing}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function EscalationTab({ stage }: { stage: FunnelStageStrategy }) {
  const priorityClasses: Record<string, string> = {
    urgent: 'bg-aurea-rose/10 border-l-aurea-rose',
    high: 'bg-aurea-amber/10 border-l-aurea-amber',
    medium: 'bg-aurea-gold/10 border-l-aurea-gold',
  }
  const priorityTextClasses: Record<string, string> = {
    urgent: 'text-aurea-rose',
    high: 'text-aurea-amber',
    medium: 'text-aurea-ink-2',
  }
  return (
    <div className="space-y-3">
      {stage.escalationTriggers.map((trigger, idx) => (
        <div
          key={idx}
          className={`p-4 rounded-sm border border-aurea-border border-l-4 ${priorityClasses[trigger.priority] ?? 'bg-aurea-surface-2 border-l-aurea-border'}`}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-[10.5px] font-bold uppercase tracking-wide ${priorityTextClasses[trigger.priority] ?? 'text-aurea-ink-3'}`}>
              {trigger.priority}
            </span>
            {trigger.afterHours > 0 && (
              <span className="text-[11px] font-mono text-aurea-ink-3 flex items-center gap-1">
                <Clock className="h-3 w-3" strokeWidth={1.75} />
                After {trigger.afterHours < 24 ? `${trigger.afterHours}h` : `${Math.round(trigger.afterHours / 24)}d`}
              </span>
            )}
          </div>
          <p className="text-[13px] font-medium text-aurea-ink">{trigger.condition}</p>
          <p className="text-[12px] text-aurea-ink-3 mt-1">
            <ArrowRight className="h-3 w-3 inline mr-1" strokeWidth={1.75} />
            {trigger.action}
          </p>
        </div>
      ))}
    </div>
  )
}

function KPIsTab({ stage }: { stage: FunnelStageStrategy }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {stage.kpis.map((kpi, idx) => (
        <div key={idx} className="p-4 bg-aurea-surface-2 border border-aurea-border rounded-sm">
          <div className="flex items-center justify-between">
            <h5 className="text-[13px] font-medium text-aurea-ink">{kpi.name}</h5>
            <span className="font-mono tabular-nums text-[13px] font-semibold text-aurea-primary">
              {kpi.target}
            </span>
          </div>
          <p className="text-[11px] text-aurea-ink-3 mt-1">{kpi.description}</p>
          <div className="mt-2 h-[3px] bg-aurea-border rounded-full overflow-hidden">
            <div className="h-full bg-aurea-primary/60 rounded-full" style={{ width: '0%' }} />
          </div>
        </div>
      ))}
    </div>
  )
}
