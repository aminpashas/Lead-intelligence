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
    <div className="space-y-6">
      {/* Pipeline Overview Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-card border rounded-xl p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Users className="h-4 w-4" />
            Total Leads
          </div>
          <p className="text-2xl font-bold mt-1">{totalLeads}</p>
        </div>
        <div className="bg-card border rounded-xl p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <DollarSign className="h-4 w-4" />
            Pipeline Value
          </div>
          <p className="text-2xl font-bold mt-1">${totalPipelineValue.toLocaleString()}</p>
        </div>
        <div className="bg-card border rounded-xl p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Target className="h-4 w-4" />
            Active Stages
          </div>
          <p className="text-2xl font-bold mt-1">{stages.filter((s) => !s.is_won && !s.is_lost).length}</p>
        </div>
        <div className="bg-card border rounded-xl p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Zap className="h-4 w-4" />
            Automations
          </div>
          <p className="text-2xl font-bold mt-1">{FUNNEL_STAGES.reduce((sum, s) => sum + s.entryActions.length + s.engagementRules.length, 0)}</p>
        </div>
      </div>

      {/* Visual Funnel */}
      <div className="bg-card border rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">Conversion Funnel</h2>
        <div className="space-y-1">
          {FUNNEL_STAGES.filter((s) => s.slug !== 'lost').map((stage, idx) => {
            const metrics = stageMetrics[stage.slug]
            const count = metrics?.count || 0
            const maxCount = Math.max(...Object.values(stageMetrics).map((m) => m.count), 1)
            const widthPct = Math.max(20, (count / maxCount) * 100)
            const pipelineStage = stages.find((s) => s.slug === stage.slug)
            const color = pipelineStage?.color || '#6B7280'

            return (
              <div key={stage.slug} className="flex items-center gap-3">
                <div className="w-40 text-sm text-right truncate">{stage.name}</div>
                <div className="flex-1 relative">
                  <div
                    className="h-8 rounded-md flex items-center px-3 transition-all"
                    style={{
                      width: `${widthPct}%`,
                      backgroundColor: `${color}20`,
                      borderLeft: `4px solid ${color}`,
                    }}
                  >
                    <span className="text-xs font-medium">{count} leads</span>
                    {metrics?.totalValue > 0 && (
                      <span className="text-xs text-muted-foreground ml-auto">
                        ${metrics.totalValue.toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>
                {idx < FUNNEL_STAGES.filter((s) => s.slug !== 'lost').length - 1 && (
                  <div className="w-6 flex justify-center">
                    <ArrowRight className="h-3 w-3 text-muted-foreground" />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Stage-by-Stage Playbook */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Stage Playbook</h2>

        {FUNNEL_STAGES.map((stage) => {
          const isExpanded = expandedStage === stage.slug
          const metrics = stageMetrics[stage.slug]
          const pipelineStage = stages.find((s) => s.slug === stage.slug)
          const color = pipelineStage?.color || '#6B7280'
          const intensityBadge = getIntensityBadge(stage.engagementIntensity)
          const urgencyClass = getStageUrgencyColor(stage.urgency)
          const tab = getTabForStage(stage.slug)

          return (
            <div key={stage.slug} className="bg-card border rounded-xl overflow-hidden">
              {/* Stage Header */}
              <button
                onClick={() => toggleStage(stage.slug)}
                className="w-full flex items-center gap-4 p-4 hover:bg-accent/50 transition-colors text-left"
              >
                <div
                  className="w-3 h-12 rounded-full flex-shrink-0"
                  style={{ backgroundColor: color }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold">{stage.name}</h3>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${intensityBadge.color}`}>
                      {intensityBadge.label}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${urgencyClass}`}>
                      {stage.urgency.charAt(0).toUpperCase() + stage.urgency.slice(1)} Priority
                    </span>
                    {stage.maxDaysInStage && (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Timer className="h-3 w-3" />
                        Max {stage.maxDaysInStage}d
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">{stage.goal}</p>
                </div>

                {/* Stage Metrics */}
                <div className="flex items-center gap-4 flex-shrink-0 text-sm">
                  {metrics && (
                    <>
                      <div className="text-center">
                        <div className="font-semibold">{metrics.count}</div>
                        <div className="text-xs text-muted-foreground">Leads</div>
                      </div>
                      {metrics.totalValue > 0 && (
                        <div className="text-center">
                          <div className="font-semibold">${(metrics.totalValue / 1000).toFixed(0)}k</div>
                          <div className="text-xs text-muted-foreground">Value</div>
                        </div>
                      )}
                      {metrics.hotLeads > 0 && (
                        <div className="text-center">
                          <div className="font-semibold text-orange-500 flex items-center gap-1">
                            <Flame className="h-3 w-3" />{metrics.hotLeads}
                          </div>
                          <div className="text-xs text-muted-foreground">Hot</div>
                        </div>
                      )}
                      {metrics.noResponseCount > 0 && (
                        <div className="text-center">
                          <div className="font-semibold text-red-500">{metrics.noResponseCount}</div>
                          <div className="text-xs text-muted-foreground">No Reply</div>
                        </div>
                      )}
                    </>
                  )}
                  {isExpanded ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
                </div>
              </button>

              {/* Expanded Content */}
              {isExpanded && (
                <div className="border-t">
                  {/* Tabs */}
                  <div className="flex border-b px-4">
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
                        className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                          tab === t.id
                            ? 'border-primary text-primary'
                            : 'border-transparent text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        <t.icon className="h-3.5 w-3.5" />
                        {t.label}
                      </button>
                    ))}
                  </div>

                  <div className="p-5">
                    {/* Sales Strategy Tab */}
                    {tab === 'strategy' && (
                      <SalesStrategyTab stage={stage} />
                    )}

                    {/* Automations Tab */}
                    {tab === 'automation' && (
                      <AutomationsTab stage={stage} />
                    )}

                    {/* Engagement Rules Tab */}
                    {tab === 'engagement' && (
                      <EngagementTab stage={stage} />
                    )}

                    {/* Escalation Tab */}
                    {tab === 'escalation' && (
                      <EscalationTab stage={stage} />
                    )}

                    {/* KPIs Tab */}
                    {tab === 'kpis' && (
                      <KPIsTab stage={stage} />
                    )}
                  </div>

                  {/* Stage Transitions */}
                  <div className="border-t px-5 py-3 bg-muted/30 flex items-center gap-4 text-sm">
                    <div className="flex items-center gap-1.5">
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                      <span className="text-muted-foreground">Success:</span>
                      <span className="font-medium">{stage.successTransition}</span>
                    </div>
                    {stage.failureTransitions.length > 0 && (
                      <div className="flex items-center gap-1.5">
                        <XCircle className="h-4 w-4 text-red-500" />
                        <span className="text-muted-foreground">Failure:</span>
                        <span className="font-medium">{stage.failureTransitions.join(', ')}</span>
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
            <h4 className="font-semibold flex items-center gap-2">
              <Shield className="h-4 w-4 text-primary" />
              {strategy.name}
            </h4>
            <p className="text-sm text-muted-foreground mt-1">{strategy.description}</p>
          </div>

          {/* Talk Track */}
          <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
            <div className="flex items-center gap-1.5 text-sm font-medium text-blue-700 dark:text-blue-300 mb-2">
              <MessageSquare className="h-3.5 w-3.5" />
              Talk Track
            </div>
            <p className="text-sm italic">&ldquo;{strategy.talkTrack}&rdquo;</p>
          </div>

          {/* Objection Handlers */}
          {strategy.objectionHandlers.length > 0 && (
            <div className="space-y-2">
              <h5 className="text-sm font-medium flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                Objection Handlers
              </h5>
              {strategy.objectionHandlers.map((oh, ohIdx) => (
                <div key={ohIdx} className="bg-muted/50 rounded-lg p-3 space-y-2">
                  <div className="flex items-start gap-2">
                    <span className="text-red-500 font-medium text-xs mt-0.5 shrink-0">OBJECTION:</span>
                    <p className="text-sm">&ldquo;{oh.objection}&rdquo;</p>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-green-600 font-medium text-xs mt-0.5 shrink-0">RESPONSE:</span>
                    <p className="text-sm">&ldquo;{oh.response}&rdquo;</p>
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
      <h4 className="font-semibold">When a lead enters &ldquo;{stage.name}&rdquo;</h4>
      <div className="space-y-2">
        {stage.entryActions.map((action, idx) => (
          <div key={idx} className="flex items-start gap-3 p-3 bg-muted/50 rounded-lg">
            <div className="mt-0.5">
              {action.type === 'sms' && <MessageSquare className="h-4 w-4 text-green-500" />}
              {action.type === 'email' && <Mail className="h-4 w-4 text-blue-500" />}
              {action.type === 'task' && <CheckCircle2 className="h-4 w-4 text-purple-500" />}
              {action.type === 'notification' && <AlertTriangle className="h-4 w-4 text-amber-500" />}
              {action.type === 'ai_score' && <Zap className="h-4 w-4 text-primary" />}
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium uppercase text-muted-foreground">
                  {action.type.replace('_', ' ')}
                </span>
                <span className="text-xs text-muted-foreground">
                  {action.delay_minutes === 0
                    ? 'Immediately'
                    : action.delay_minutes < 60
                      ? `After ${action.delay_minutes}m`
                      : action.delay_minutes < 1440
                        ? `After ${Math.round(action.delay_minutes / 60)}h`
                        : `After ${Math.round(action.delay_minutes / 1440)}d`}
                </span>
              </div>
              <p className="text-sm mt-0.5">{action.description}</p>
              {action.template && (
                <div className="mt-2 p-2 bg-background rounded border text-xs text-muted-foreground">
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
        <div key={idx} className="flex items-start gap-3 p-4 bg-muted/50 rounded-lg">
          <div className="mt-0.5">
            {rule.channel === 'sms' && <MessageSquare className="h-4 w-4 text-green-500" />}
            {rule.channel === 'email' && <Mail className="h-4 w-4 text-blue-500" />}
            {rule.channel === 'call' && <Phone className="h-4 w-4 text-purple-500" />}
            {rule.channel === 'multi' && <Zap className="h-4 w-4 text-primary" />}
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-medium uppercase px-2 py-0.5 rounded bg-background border">
                {rule.channel}
              </span>
              <span className="text-xs text-muted-foreground">{rule.frequency}</span>
              {rule.aiPersonalize && (
                <span className="text-xs px-2 py-0.5 rounded bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                  AI Personalized
                </span>
              )}
            </div>
            <p className="text-sm mt-1.5">{rule.description}</p>
            <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
              <Clock className="h-3 w-3" />
              {rule.timing}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function EscalationTab({ stage }: { stage: FunnelStageStrategy }) {
  return (
    <div className="space-y-3">
      {stage.escalationTriggers.map((trigger, idx) => (
        <div
          key={idx}
          className={`p-4 rounded-lg border-l-4 ${
            trigger.priority === 'urgent'
              ? 'bg-red-50 dark:bg-red-950/20 border-red-500'
              : trigger.priority === 'high'
                ? 'bg-orange-50 dark:bg-orange-950/20 border-orange-500'
                : 'bg-yellow-50 dark:bg-yellow-950/20 border-yellow-500'
          }`}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-xs font-bold uppercase ${
              trigger.priority === 'urgent' ? 'text-red-600' : trigger.priority === 'high' ? 'text-orange-600' : 'text-yellow-600'
            }`}>
              {trigger.priority}
            </span>
            {trigger.afterHours > 0 && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="h-3 w-3" />
                After {trigger.afterHours < 24 ? `${trigger.afterHours}h` : `${Math.round(trigger.afterHours / 24)}d`}
              </span>
            )}
          </div>
          <p className="text-sm font-medium">{trigger.condition}</p>
          <p className="text-sm text-muted-foreground mt-1">
            <ArrowRight className="h-3 w-3 inline mr-1" />
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
        <div key={idx} className="p-4 bg-muted/50 rounded-lg">
          <div className="flex items-center justify-between">
            <h5 className="text-sm font-medium">{kpi.name}</h5>
            <span className="text-sm font-bold text-primary">{kpi.target}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">{kpi.description}</p>
          <div className="mt-2 h-1.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-primary/60 rounded-full" style={{ width: '0%' }} />
          </div>
        </div>
      ))}
    </div>
  )
}
