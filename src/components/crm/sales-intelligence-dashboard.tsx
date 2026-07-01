'use client'

import { useState, useEffect } from 'react'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Brain,
  TrendingUp,
  TrendingDown,
  Minus,
  Target,
  Shield,
  Zap,
  BarChart3,
} from 'lucide-react'
import {
  SALES_TECHNIQUES,
  TECHNIQUE_CATEGORIES,
  TECHNIQUE_CATEGORY_COLORS,
  getTechniqueById,
  type TechniqueCategory,
} from '@/lib/ai/sales-techniques'
import { toast } from 'sonner'

type TechniqueStats = {
  total: number
  effective: number
  neutral: number
  backfired: number
  effectiveness_rate?: number
}

type ConversationSummary = {
  id: string
  conversation_id: string
  lead_id: string
  total_techniques_used: number
  unique_techniques_used: number
  techniques_breakdown: Record<string, TechniqueStats>
  category_breakdown: Record<string, number>
  most_effective_technique: string | null
  technique_diversity_score: number
  approach_adaptation_score: number
  final_engagement_temperature: number | null
  final_buying_readiness: number | null
  engagement_trend: 'improving' | 'stable' | 'declining' | null
  created_at: string
}

type OrgStats = {
  total_technique_uses: number
  by_technique: Record<string, TechniqueStats>
  by_category: Record<string, number>
  top_techniques: Array<{ technique_id: string } & TechniqueStats & { effectiveness_rate: number }>
  bottom_techniques: Array<{ technique_id: string } & TechniqueStats & { effectiveness_rate: number }>
  conversation_summaries: ConversationSummary[]
  recent_assessments: Array<{
    engagement_temperature: number
    resistance_level: number
    buying_readiness: number
    emotional_state: string
    created_at: string
  }>
}

function TrendIcon({ trend }: { trend: string | null }) {
  if (trend === 'improving') return <TrendingUp className="h-4 w-4 text-aurea-primary" strokeWidth={1.75} />
  if (trend === 'declining') return <TrendingDown className="h-4 w-4 text-aurea-rose" strokeWidth={1.75} />
  return <Minus className="h-4 w-4 text-aurea-amber" strokeWidth={1.75} />
}

function ScoreBar({ value, max = 10 }: { value: number; max?: number }) {
  const pct = Math.min(100, (value / max) * 100)
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-[3px] bg-aurea-surface-2 rounded-full overflow-hidden">
        <div className="h-full rounded-full bg-aurea-primary" style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3 w-8 text-right">{value}/{max}</span>
    </div>
  )
}

function EffectivenessBar({ stats }: { stats: TechniqueStats }) {
  const total = stats.total || 1
  const effPct = (stats.effective / total) * 100
  const neuPct = (stats.neutral / total) * 100
  const badPct = (stats.backfired / total) * 100
  return (
    <div className="flex h-[3px] rounded-full overflow-hidden bg-aurea-surface-2">
      <div className="bg-aurea-primary" style={{ width: `${effPct}%` }} />
      <div className="bg-aurea-amber" style={{ width: `${neuPct}%` }} />
      <div className="bg-aurea-rose" style={{ width: `${badPct}%` }} />
    </div>
  )
}

export function SalesIntelligenceDashboard() {
  const [stats, setStats] = useState<OrgStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchStats()
  }, [])

  async function fetchStats() {
    try {
      const res = await fetch('/api/ai/technique-stats')
      if (!res.ok) throw new Error('Failed to fetch')
      const data = await res.json()
      setStats(data)
    } catch {
      toast.error('Failed to load sales intelligence data')
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="py-12 text-center text-[13px] text-aurea-ink-3">
        Loading sales intelligence…
      </div>
    )
  }

  if (!stats || stats.total_technique_uses === 0) {
    return (
      <div className="aurea-card p-12 flex flex-col items-center justify-center text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-aurea-surface-2 ring-1 ring-aurea-border mb-6">
          <Brain className="h-8 w-8 text-aurea-ink-3" strokeWidth={1.75} />
        </div>
        <h3 className="aurea-display text-[22px] text-aurea-ink">No Sales Intelligence Data Yet</h3>
        <p className="mt-2 max-w-lg text-[13px] leading-relaxed text-aurea-ink-3">
          Once the AI agents start handling conversations, this dashboard will show which sales techniques are being used,
          their effectiveness, how the AI adapts its approach per lead, and real-time engagement tracking.
        </p>
        <div className="mt-8 grid grid-cols-2 md:grid-cols-4 gap-4 max-w-2xl w-full">
          {[
            { icon: Target, label: 'Closing Techniques', count: 6, accent: 'rose' as const },
            { icon: Shield, label: 'Objection Handling', count: 4, accent: 'amber' as const },
            { icon: Zap, label: 'Persuasion', count: 6, accent: 'primary' as const },
            { icon: BarChart3, label: 'Psychology', count: 4, accent: 'primary' as const },
          ].map((item) => (
            <div key={item.label} className="aurea-card p-4 text-center">
              <div className={`flex h-8 w-8 mx-auto mb-2 items-center justify-center rounded-full bg-aurea-surface-2 ${
                item.accent === 'rose' ? 'text-aurea-rose' :
                item.accent === 'amber' ? 'text-aurea-amber' :
                'text-aurea-primary'
              }`}>
                <item.icon className="h-4 w-4" strokeWidth={1.75} />
              </div>
              <p className="text-[12px] font-medium text-aurea-ink">{item.label}</p>
              <p className="font-mono text-[11px] tabular-nums text-aurea-ink-3">{item.count} techniques</p>
            </div>
          ))}
        </div>
        <p className="mt-6 font-mono text-[11px] text-aurea-ink-3">
          {SALES_TECHNIQUES.length} techniques tracked across {Object.keys(TECHNIQUE_CATEGORIES).length} categories
        </p>
      </div>
    )
  }

  const totalCategories = Object.keys(TECHNIQUE_CATEGORIES).length
  const usedCategories = Object.keys(stats.by_category).length
  const avgDiversity = stats.conversation_summaries.length > 0
    ? stats.conversation_summaries.reduce((sum, s) => sum + (s.technique_diversity_score || 0), 0) / stats.conversation_summaries.length
    : 0
  const avgAdaptation = stats.conversation_summaries.length > 0
    ? stats.conversation_summaries.reduce((sum, s) => sum + (s.approach_adaptation_score || 0), 0) / stats.conversation_summaries.length
    : 0
  const improvingConvos = stats.conversation_summaries.filter((s) => s.engagement_trend === 'improving').length
  const totalConvos = stats.conversation_summaries.length

  return (
    <Tabs defaultValue="overview" className="space-y-6">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="techniques">Technique Effectiveness</TabsTrigger>
        <TabsTrigger value="conversations">Conversation Scorecards</TabsTrigger>
        <TabsTrigger value="library">Technique Library</TabsTrigger>
      </TabsList>

      {/* ── OVERVIEW TAB ─────────────────────────────────────── */}
      <TabsContent value="overview" className="space-y-5">
        {/* KPI Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { index: '01', label: 'Total Techniques Used', value: stats.total_technique_uses, sub: `across ${totalConvos} conversations` },
            { index: '02', label: 'Category Coverage', value: `${usedCategories}/${totalCategories}`, sub: 'technique categories used' },
            { index: '03', label: 'Avg Diversity Score', value: `${(avgDiversity * 100).toFixed(0)}%`, sub: 'technique variety / conversation' },
            { index: '04', label: 'Engagement Improving', value: `${totalConvos > 0 ? ((improvingConvos / totalConvos) * 100).toFixed(0) : 0}%`, sub: `${improvingConvos} of ${totalConvos} conversations`, accent: 'primary' as const },
          ].map((kpi) => (
            <div key={kpi.label} className="aurea-card p-5">
              <div className="flex items-center justify-between">
                <p className="aurea-eyebrow">{kpi.label}</p>
                <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3">/{kpi.index}</span>
              </div>
              <p className={`mt-4 aurea-display text-[32px] tabular-nums ${kpi.accent === 'primary' ? 'text-aurea-primary' : 'text-aurea-ink'}`}>
                {kpi.value}
              </p>
              <p className="mt-2 text-[11.5px] text-aurea-ink-3">{kpi.sub}</p>
            </div>
          ))}
        </div>

        {/* Category Breakdown */}
        <div className="aurea-card overflow-hidden">
          <div className="border-b border-aurea-border px-5 py-4">
            <h2 className="aurea-display text-[18px] text-aurea-ink">Technique Usage by Category</h2>
          </div>
          <div className="p-5 space-y-3">
            {Object.entries(TECHNIQUE_CATEGORIES).map(([key, label]) => {
              const count = stats.by_category[key] || 0
              const pct = stats.total_technique_uses > 0 ? (count / stats.total_technique_uses) * 100 : 0
              return (
                <div key={key} className="flex items-center gap-3">
                  <Badge variant="secondary" className={`w-32 justify-center text-[10px] ${TECHNIQUE_CATEGORY_COLORS[key as TechniqueCategory]}`}>
                    {label}
                  </Badge>
                  <div className="flex-1 h-[3px] bg-aurea-surface-2 rounded-full overflow-hidden">
                    <div className="h-full bg-aurea-primary rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="font-mono text-[12px] tabular-nums text-aurea-ink w-10 text-right">{count}</span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Top/Bottom Techniques */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="aurea-card overflow-hidden">
            <div className="border-b border-aurea-border px-5 py-4">
              <h2 className="aurea-display text-[18px] text-aurea-primary">Top Performing Techniques</h2>
            </div>
            <div className="p-5 space-y-4">
              {stats.top_techniques.map((t) => {
                const technique = getTechniqueById(t.technique_id)
                return (
                  <div key={t.technique_id}>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[13px] font-medium text-aurea-ink">{technique?.name || t.technique_id}</span>
                      <span className="font-mono text-[11px] tabular-nums text-aurea-primary">{(t.effectiveness_rate * 100).toFixed(0)}% effective</span>
                    </div>
                    <EffectivenessBar stats={t} />
                    <p className="font-mono text-[11px] text-aurea-ink-3 mt-0.5">Used {t.total} times</p>
                  </div>
                )
              })}
              {stats.top_techniques.length === 0 && (
                <p className="text-[13px] text-aurea-ink-3">No data yet</p>
              )}
            </div>
          </div>

          <div className="aurea-card overflow-hidden">
            <div className="border-b border-aurea-border px-5 py-4">
              <h2 className="aurea-display text-[18px] text-aurea-rose">Needs Improvement</h2>
            </div>
            <div className="p-5 space-y-4">
              {stats.bottom_techniques.map((t) => {
                const technique = getTechniqueById(t.technique_id)
                return (
                  <div key={t.technique_id}>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[13px] font-medium text-aurea-ink">{technique?.name || t.technique_id}</span>
                      <span className="font-mono text-[11px] tabular-nums text-aurea-rose">{(t.effectiveness_rate * 100).toFixed(0)}% effective</span>
                    </div>
                    <EffectivenessBar stats={t} />
                    <p className="font-mono text-[11px] text-aurea-ink-3 mt-0.5">Used {t.total} times</p>
                  </div>
                )
              })}
              {stats.bottom_techniques.length === 0 && (
                <p className="text-[13px] text-aurea-ink-3">No data yet</p>
              )}
            </div>
          </div>
        </div>

        {/* Adaptation Score */}
        <div className="aurea-card overflow-hidden">
          <div className="border-b border-aurea-border px-5 py-4">
            <h2 className="aurea-display text-[18px] text-aurea-ink">AI Adaptation Performance</h2>
          </div>
          <div className="p-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <p className="text-[13px] font-medium text-aurea-ink mb-1">Approach Adaptation Score</p>
                <p className="text-[11.5px] text-aurea-ink-3 mb-2">Does the AI change techniques when resistance increases?</p>
                <ScoreBar value={parseFloat((avgAdaptation * 10).toFixed(1))} max={10} />
              </div>
              <div>
                <p className="text-[13px] font-medium text-aurea-ink mb-1">Technique Diversity Score</p>
                <p className="text-[11.5px] text-aurea-ink-3 mb-2">How many different technique categories does the AI use?</p>
                <ScoreBar value={parseFloat((avgDiversity * 10).toFixed(1))} max={10} />
              </div>
            </div>
          </div>
        </div>
      </TabsContent>

      {/* ── TECHNIQUE EFFECTIVENESS TAB ──────────────────────── */}
      <TabsContent value="techniques" className="space-y-4">
        <div className="aurea-card overflow-hidden">
          <div className="border-b border-aurea-border px-5 py-4">
            <h2 className="aurea-display text-[18px] text-aurea-ink">All Technique Effectiveness</h2>
          </div>
          <div className="p-5 space-y-6">
            {Object.entries(TECHNIQUE_CATEGORIES).map(([catKey, catLabel]) => {
              const catTechniques = SALES_TECHNIQUES.filter((t) => t.category === catKey)
              const hasTechniqueData = catTechniques.some((t) => stats.by_technique[t.id])
              if (!hasTechniqueData) return null

              return (
                <div key={catKey}>
                  <div className="flex items-center gap-2 mb-3">
                    <Badge variant="secondary" className={`text-[10px] ${TECHNIQUE_CATEGORY_COLORS[catKey as TechniqueCategory]}`}>
                      {catLabel}
                    </Badge>
                  </div>
                  <div className="space-y-2 ml-1">
                    {catTechniques.map((technique) => {
                      const techStats = stats.by_technique[technique.id]
                      if (!techStats) return null
                      const effRate = techStats.total > 0 ? (techStats.effective / techStats.total) * 100 : 0
                      return (
                        <div key={technique.id} className="flex items-center gap-3">
                          <span className="text-[13px] text-aurea-ink-2 w-48 truncate">{technique.name}</span>
                          <div className="flex-1">
                            <EffectivenessBar stats={techStats} />
                          </div>
                          <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3 w-20 text-right">
                            {effRate.toFixed(0)}% ({techStats.total})
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </TabsContent>

      {/* ── CONVERSATION SCORECARDS TAB ──────────────────────── */}
      <TabsContent value="conversations" className="space-y-3">
        {stats.conversation_summaries.length === 0 ? (
          <div className="aurea-card p-12 text-center text-[13px] text-aurea-ink-3">
            No conversation scorecards yet.
          </div>
        ) : (
          stats.conversation_summaries.map((summary) => (
            <div key={summary.id} className="aurea-card p-5">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <p className="text-[14px] font-medium text-aurea-ink">Conversation {summary.conversation_id.slice(0, 8)}…</p>
                  <p className="font-mono text-[11px] text-aurea-ink-3">{new Date(summary.created_at).toLocaleDateString()}</p>
                </div>
                <div className="flex items-center gap-2">
                  <TrendIcon trend={summary.engagement_trend} />
                  <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${
                    summary.engagement_trend === 'improving'
                      ? 'border-aurea-primary/30 bg-aurea-primary/5 text-aurea-primary'
                      : summary.engagement_trend === 'declining'
                      ? 'border-aurea-rose/30 bg-aurea-rose/5 text-aurea-rose'
                      : 'border-aurea-border bg-aurea-surface-2 text-aurea-ink-3'
                  }`}>
                    {summary.engagement_trend || 'N/A'}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
                {[
                  { label: 'Techniques', value: summary.total_techniques_used },
                  { label: 'Unique', value: summary.unique_techniques_used },
                  { label: 'Diversity', value: `${((summary.technique_diversity_score || 0) * 100).toFixed(0)}%` },
                  { label: 'Engagement', value: `${summary.final_engagement_temperature ?? '—'}/10` },
                  { label: 'Buying Ready', value: `${summary.final_buying_readiness ?? '—'}/10` },
                ].map((stat) => (
                  <div key={stat.label}>
                    <p className="aurea-eyebrow">{stat.label}</p>
                    <p className="mt-1 aurea-display text-[20px] tabular-nums text-aurea-ink">{stat.value}</p>
                  </div>
                ))}
              </div>

              {/* Category badges */}
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(summary.category_breakdown || {}).map(([cat, count]) => (
                  <Badge key={cat} variant="secondary" className={`text-[10px] ${TECHNIQUE_CATEGORY_COLORS[cat as TechniqueCategory] || ''}`}>
                    {TECHNIQUE_CATEGORIES[cat as TechniqueCategory] || cat}: {count as number}
                  </Badge>
                ))}
              </div>

              {summary.most_effective_technique && (
                <p className="mt-2.5 text-[11.5px] text-aurea-ink-3">
                  Most effective: <strong className="text-aurea-ink">{getTechniqueById(summary.most_effective_technique)?.name || summary.most_effective_technique}</strong>
                </p>
              )}
            </div>
          ))
        )}
      </TabsContent>

      {/* ── TECHNIQUE LIBRARY TAB ─────────────────────────────── */}
      <TabsContent value="library" className="space-y-4">
        {Object.entries(TECHNIQUE_CATEGORIES).map(([catKey, catLabel]) => {
          const catTechniques = SALES_TECHNIQUES.filter((t) => t.category === catKey)
          return (
            <div key={catKey} className="aurea-card overflow-hidden">
              <div className="flex items-center gap-2.5 border-b border-aurea-border px-5 py-4">
                <Badge variant="secondary" className={`text-[10px] ${TECHNIQUE_CATEGORY_COLORS[catKey as TechniqueCategory]}`}>
                  {catLabel}
                </Badge>
                <span className="text-[12px] text-aurea-ink-3">({catTechniques.length} techniques)</span>
              </div>
              <div className="p-5 space-y-3">
                {catTechniques.map((technique) => (
                  <div key={technique.id} className="rounded-lg border border-aurea-border bg-aurea-surface-2 p-4">
                    <div className="flex items-center justify-between mb-1.5">
                      <h4 className="text-[13px] font-medium text-aurea-ink">{technique.name}</h4>
                      <div className="flex items-center gap-1.5">
                        <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${
                          technique.risk_level === 'high'
                            ? 'border-aurea-rose/30 bg-aurea-rose/5 text-aurea-rose'
                            : technique.risk_level === 'medium'
                            ? 'border-aurea-amber/30 bg-aurea-amber/5 text-aurea-amber'
                            : 'border-aurea-border bg-aurea-canvas text-aurea-ink-3'
                        }`}>
                          {technique.risk_level} risk
                        </span>
                        {technique.setter_applicable && (
                          <span className="inline-flex items-center rounded-md border border-aurea-border px-1.5 py-0.5 text-[10px] text-aurea-ink-3">
                            Setter
                          </span>
                        )}
                        {technique.closer_applicable && (
                          <span className="inline-flex items-center rounded-md border border-aurea-border px-1.5 py-0.5 text-[10px] text-aurea-ink-3">
                            Closer
                          </span>
                        )}
                      </div>
                    </div>
                    <p className="text-[12px] text-aurea-ink-2 leading-relaxed">{technique.description}</p>
                    <p className="text-[11.5px] text-aurea-ink-3 mt-1.5"><strong className="text-aurea-ink-2">When:</strong> {technique.when_to_use}</p>
                    {technique.example_phrases.length > 0 && (
                      <p className="text-[11.5px] text-aurea-ink-3 mt-1 italic">
                        &quot;{technique.example_phrases[0]}&quot;
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </TabsContent>
    </Tabs>
  )
}
