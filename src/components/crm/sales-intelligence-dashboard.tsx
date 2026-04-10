'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
  if (trend === 'improving') return <TrendingUp className="h-4 w-4 text-green-500" />
  if (trend === 'declining') return <TrendingDown className="h-4 w-4 text-red-500" />
  return <Minus className="h-4 w-4 text-yellow-500" />
}

function ScoreBar({ value, max = 10, color = 'bg-primary' }: { value: number; max?: number; color?: string }) {
  const pct = Math.min(100, (value / max) * 100)
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-medium w-8 text-right">{value}/{max}</span>
    </div>
  )
}

function EffectivenessBar({ stats }: { stats: TechniqueStats }) {
  const total = stats.total || 1
  const effPct = (stats.effective / total) * 100
  const neuPct = (stats.neutral / total) * 100
  const badPct = (stats.backfired / total) * 100
  return (
    <div className="flex h-2 rounded-full overflow-hidden bg-muted">
      <div className="bg-green-500" style={{ width: `${effPct}%` }} />
      <div className="bg-yellow-500" style={{ width: `${neuPct}%` }} />
      <div className="bg-red-500" style={{ width: `${badPct}%` }} />
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
    return <div className="text-center py-12 text-muted-foreground">Loading sales intelligence...</div>
  }

  if (!stats || stats.total_technique_uses === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <Brain className="h-16 w-16 text-muted-foreground/30 mb-4" />
          <h3 className="font-semibold text-xl">No Sales Intelligence Data Yet</h3>
          <p className="text-sm text-muted-foreground mt-2 max-w-lg">
            Once the AI agents start handling conversations, this dashboard will show which sales techniques are being used,
            their effectiveness, how the AI adapts its approach per lead, and real-time engagement tracking.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-8 max-w-2xl">
            <div className="text-center p-3 rounded-lg bg-muted/50">
              <Target className="h-6 w-6 mx-auto mb-1 text-red-500" />
              <p className="text-xs font-medium">Closing Techniques</p>
              <p className="text-xs text-muted-foreground">6 techniques</p>
            </div>
            <div className="text-center p-3 rounded-lg bg-muted/50">
              <Shield className="h-6 w-6 mx-auto mb-1 text-orange-500" />
              <p className="text-xs font-medium">Objection Handling</p>
              <p className="text-xs text-muted-foreground">4 techniques</p>
            </div>
            <div className="text-center p-3 rounded-lg bg-muted/50">
              <Zap className="h-6 w-6 mx-auto mb-1 text-blue-500" />
              <p className="text-xs font-medium">Persuasion</p>
              <p className="text-xs text-muted-foreground">6 techniques</p>
            </div>
            <div className="text-center p-3 rounded-lg bg-muted/50">
              <BarChart3 className="h-6 w-6 mx-auto mb-1 text-purple-500" />
              <p className="text-xs font-medium">Psychology</p>
              <p className="text-xs text-muted-foreground">4 techniques</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-6">
            {SALES_TECHNIQUES.length} techniques tracked across {Object.keys(TECHNIQUE_CATEGORIES).length} categories
          </p>
        </CardContent>
      </Card>
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
    <Tabs defaultValue="overview" className="space-y-4">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="techniques">Technique Effectiveness</TabsTrigger>
        <TabsTrigger value="conversations">Conversation Scorecards</TabsTrigger>
        <TabsTrigger value="library">Technique Library</TabsTrigger>
      </TabsList>

      {/* OVERVIEW TAB */}
      <TabsContent value="overview" className="space-y-4">
        {/* KPI Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground">Total Techniques Used</p>
              <p className="text-3xl font-bold">{stats.total_technique_uses}</p>
              <p className="text-xs text-muted-foreground mt-1">across {totalConvos} conversations</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground">Category Coverage</p>
              <p className="text-3xl font-bold">{usedCategories}/{totalCategories}</p>
              <p className="text-xs text-muted-foreground mt-1">technique categories used</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground">Avg Diversity Score</p>
              <p className="text-3xl font-bold">{(avgDiversity * 100).toFixed(0)}%</p>
              <p className="text-xs text-muted-foreground mt-1">technique variety per conversation</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground">Engagement Improving</p>
              <p className="text-3xl font-bold">{totalConvos > 0 ? ((improvingConvos / totalConvos) * 100).toFixed(0) : 0}%</p>
              <p className="text-xs text-muted-foreground mt-1">{improvingConvos} of {totalConvos} conversations</p>
            </CardContent>
          </Card>
        </div>

        {/* Category Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Technique Usage by Category</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {Object.entries(TECHNIQUE_CATEGORIES).map(([key, label]) => {
                const count = stats.by_category[key] || 0
                const pct = stats.total_technique_uses > 0 ? (count / stats.total_technique_uses) * 100 : 0
                return (
                  <div key={key} className="flex items-center gap-3">
                    <Badge variant="secondary" className={`w-32 justify-center ${TECHNIQUE_CATEGORY_COLORS[key as TechniqueCategory]}`}>
                      {label}
                    </Badge>
                    <div className="flex-1 h-3 bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-primary rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-sm font-medium w-12 text-right">{count}</span>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>

        {/* Top/Bottom Techniques */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm text-green-600">Top Performing Techniques</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {stats.top_techniques.map((t) => {
                const technique = getTechniqueById(t.technique_id)
                return (
                  <div key={t.technique_id}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium">{technique?.name || t.technique_id}</span>
                      <span className="text-xs text-green-600 font-medium">{(t.effectiveness_rate * 100).toFixed(0)}% effective</span>
                    </div>
                    <EffectivenessBar stats={t} />
                    <p className="text-xs text-muted-foreground mt-0.5">Used {t.total} times</p>
                  </div>
                )
              })}
              {stats.top_techniques.length === 0 && (
                <p className="text-sm text-muted-foreground">No data yet</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm text-red-600">Needs Improvement</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {stats.bottom_techniques.map((t) => {
                const technique = getTechniqueById(t.technique_id)
                return (
                  <div key={t.technique_id}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium">{technique?.name || t.technique_id}</span>
                      <span className="text-xs text-red-600 font-medium">{(t.effectiveness_rate * 100).toFixed(0)}% effective</span>
                    </div>
                    <EffectivenessBar stats={t} />
                    <p className="text-xs text-muted-foreground mt-0.5">Used {t.total} times</p>
                  </div>
                )
              })}
              {stats.bottom_techniques.length === 0 && (
                <p className="text-sm text-muted-foreground">No data yet</p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Adaptation Score */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">AI Adaptation Performance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <p className="text-sm text-muted-foreground mb-2">Approach Adaptation Score</p>
                <p className="text-xs text-muted-foreground mb-1">Does the AI change techniques when resistance increases?</p>
                <ScoreBar value={parseFloat((avgAdaptation * 10).toFixed(1))} max={10} color="bg-blue-500" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground mb-2">Technique Diversity Score</p>
                <p className="text-xs text-muted-foreground mb-1">How many different technique categories does the AI use?</p>
                <ScoreBar value={parseFloat((avgDiversity * 10).toFixed(1))} max={10} color="bg-purple-500" />
              </div>
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      {/* TECHNIQUE EFFECTIVENESS TAB */}
      <TabsContent value="techniques" className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">All Technique Effectiveness</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {Object.entries(TECHNIQUE_CATEGORIES).map(([catKey, catLabel]) => {
                const catTechniques = SALES_TECHNIQUES.filter((t) => t.category === catKey)
                const hasTechniqueData = catTechniques.some((t) => stats.by_technique[t.id])
                if (!hasTechniqueData) return null

                return (
                  <div key={catKey}>
                    <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                      <Badge variant="secondary" className={TECHNIQUE_CATEGORY_COLORS[catKey as TechniqueCategory]}>
                        {catLabel}
                      </Badge>
                    </h4>
                    <div className="space-y-2 ml-2">
                      {catTechniques.map((technique) => {
                        const techStats = stats.by_technique[technique.id]
                        if (!techStats) return null
                        const effRate = techStats.total > 0 ? (techStats.effective / techStats.total) * 100 : 0
                        return (
                          <div key={technique.id} className="flex items-center gap-3">
                            <span className="text-sm w-48 truncate">{technique.name}</span>
                            <div className="flex-1">
                              <EffectivenessBar stats={techStats} />
                            </div>
                            <span className="text-xs w-20 text-right">
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
          </CardContent>
        </Card>
      </TabsContent>

      {/* CONVERSATION SCORECARDS TAB */}
      <TabsContent value="conversations" className="space-y-3">
        {stats.conversation_summaries.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              No conversation scorecards yet.
            </CardContent>
          </Card>
        ) : (
          stats.conversation_summaries.map((summary) => (
            <Card key={summary.id}>
              <CardContent className="py-4">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <p className="text-sm font-medium">Conversation {summary.conversation_id.slice(0, 8)}...</p>
                    <p className="text-xs text-muted-foreground">{new Date(summary.created_at).toLocaleDateString()}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <TrendIcon trend={summary.engagement_trend} />
                    <Badge variant={summary.engagement_trend === 'improving' ? 'default' : summary.engagement_trend === 'declining' ? 'destructive' : 'secondary'}>
                      {summary.engagement_trend || 'N/A'}
                    </Badge>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-3">
                  <div>
                    <p className="text-xs text-muted-foreground">Techniques</p>
                    <p className="text-lg font-bold">{summary.total_techniques_used}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Unique</p>
                    <p className="text-lg font-bold">{summary.unique_techniques_used}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Diversity</p>
                    <p className="text-lg font-bold">{((summary.technique_diversity_score || 0) * 100).toFixed(0)}%</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Engagement</p>
                    <p className="text-lg font-bold">{summary.final_engagement_temperature ?? '—'}/10</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Buying Ready</p>
                    <p className="text-lg font-bold">{summary.final_buying_readiness ?? '—'}/10</p>
                  </div>
                </div>

                {/* Category badges */}
                <div className="flex flex-wrap gap-1">
                  {Object.entries(summary.category_breakdown || {}).map(([cat, count]) => (
                    <Badge key={cat} variant="secondary" className={`text-xs ${TECHNIQUE_CATEGORY_COLORS[cat as TechniqueCategory] || ''}`}>
                      {TECHNIQUE_CATEGORIES[cat as TechniqueCategory] || cat}: {count as number}
                    </Badge>
                  ))}
                </div>

                {summary.most_effective_technique && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Most effective: <strong>{getTechniqueById(summary.most_effective_technique)?.name || summary.most_effective_technique}</strong>
                  </p>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </TabsContent>

      {/* TECHNIQUE LIBRARY TAB */}
      <TabsContent value="library" className="space-y-4">
        {Object.entries(TECHNIQUE_CATEGORIES).map(([catKey, catLabel]) => {
          const catTechniques = SALES_TECHNIQUES.filter((t) => t.category === catKey)
          return (
            <Card key={catKey}>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Badge variant="secondary" className={TECHNIQUE_CATEGORY_COLORS[catKey as TechniqueCategory]}>
                    {catLabel}
                  </Badge>
                  <span className="text-muted-foreground font-normal">({catTechniques.length} techniques)</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {catTechniques.map((technique) => (
                    <div key={technique.id} className="border rounded-lg p-3">
                      <div className="flex items-center justify-between mb-1">
                        <h4 className="text-sm font-medium">{technique.name}</h4>
                        <div className="flex items-center gap-1.5">
                          <Badge variant={technique.risk_level === 'high' ? 'destructive' : technique.risk_level === 'medium' ? 'secondary' : 'outline'} className="text-xs">
                            {technique.risk_level} risk
                          </Badge>
                          {technique.setter_applicable && <Badge variant="outline" className="text-xs">Setter</Badge>}
                          {technique.closer_applicable && <Badge variant="outline" className="text-xs">Closer</Badge>}
                        </div>
                      </div>
                      <p className="text-sm text-muted-foreground">{technique.description}</p>
                      <p className="text-xs text-muted-foreground mt-1"><strong>When:</strong> {technique.when_to_use}</p>
                      {technique.example_phrases.length > 0 && (
                        <p className="text-xs text-muted-foreground mt-1 italic">
                          &quot;{technique.example_phrases[0]}&quot;
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )
        })}
      </TabsContent>
    </Tabs>
  )
}
