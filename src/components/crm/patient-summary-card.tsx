'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  Brain,
  Heart,
  AlertTriangle,
  CheckCircle2,
  Target,
  MessageSquare,
  Loader2,
  TrendingUp,
  Clock,
  Zap,
} from 'lucide-react'
import type { Lead } from '@/types/database'

type PatientSummaryData = {
  profile: {
    personality_type: string | null
    communication_style: string | null
    trust_level: string
    emotional_state: string
    anxiety_level: number
    confidence_level: number
    motivation_level: number
    rapport_score: number
    pain_points: Array<{ point: string; severity: number; mentioned_count: number }>
    desires: Array<{ desire: string; importance: number }>
    objections: Array<{ objection: string; severity: number; addressed: boolean }>
    ai_summary: string | null
    next_best_action: string | null
    recommended_tone: string | null
    key_moments: Array<{ date: string; type: string; description: string }>
    total_conversations_analyzed: number
    last_analyzed_at: string | null
  } | null
  conversation_count: number
  ai_message_count: number
  active_agent: string | null
  last_handoff: { from_agent: string; to_agent: string; trigger_reason: string } | null
}

function ScoreBar({ label, value, max = 10, color }: { label: string; value: number; max?: number; color: string }) {
  const pct = Math.min((value / max) * 100, 100)
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{value}/{max}</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function PatientSummaryCard({ leadId, lead }: { leadId: string; lead: Lead }) {
  const [data, setData] = useState<PatientSummaryData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchSummary() {
      try {
        // Fetch patient profile
        const profileRes = await fetch(`/api/leads/${leadId}?include=patient_summary`)
        if (!profileRes.ok) throw new Error()
        const profileData = await profileRes.json()

        // The API might not support this param yet, so fetch directly
        const res = await fetch(`/api/ai/audit?limit=1&page=1`)
        // We'll construct the data from what we have

        setData({
          profile: profileData.patient_profile || null,
          conversation_count: profileData.conversation_count || 0,
          ai_message_count: profileData.ai_message_count || 0,
          active_agent: profileData.active_agent || null,
          last_handoff: profileData.last_handoff || null,
        })
      } catch {
        // Build from lead data directly if API fails
        setData({
          profile: null,
          conversation_count: 0,
          ai_message_count: 0,
          active_agent: null,
          last_handoff: null,
        })
      } finally {
        setLoading(false)
      }
    }

    fetchSummary()
  }, [leadId])

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <Brain className="h-3.5 w-3.5 text-purple-500" />
            Patient Summary
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-6">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  const profile = data?.profile

  return (
    <div className="space-y-4">
      {/* AI Summary Card */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <Brain className="h-3.5 w-3.5 text-purple-500" />
            Patient Summary
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {profile?.ai_summary ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {profile.ai_summary}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground italic">
              No AI analysis yet. Analyze a conversation to build the patient profile.
            </p>
          )}

          {/* Agent indicator */}
          {data?.active_agent && data.active_agent !== 'none' && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Active agent:</span>
              <Badge variant="outline" className={`text-[10px] ${
                data.active_agent === 'setter' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-purple-50 text-purple-700 border-purple-200'
              }`}>
                {data.active_agent === 'setter' ? 'Setter' : 'Closer'}
              </Badge>
            </div>
          )}

          {/* Quick stats */}
          <div className="flex gap-3 text-xs">
            <div className="flex items-center gap-1 text-muted-foreground">
              <MessageSquare className="h-3 w-3" />
              {lead.total_messages_sent + lead.total_messages_received} msgs
            </div>
            {profile?.total_conversations_analyzed ? (
              <div className="flex items-center gap-1 text-muted-foreground">
                <Brain className="h-3 w-3" />
                {profile.total_conversations_analyzed} analyzed
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* Emotional State & Scores */}
      {profile && profile.personality_type && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              <Heart className="h-3.5 w-3.5 text-pink-500" />
              Emotional Pulse
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Personality */}
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-[10px] capitalize">
                {profile.personality_type}
              </Badge>
              {profile.communication_style && (
                <span className="text-[10px] text-muted-foreground capitalize">
                  {profile.communication_style}
                </span>
              )}
            </div>

            {/* Emotional state */}
            {profile.emotional_state && (
              <div className="text-xs">
                <span className="text-muted-foreground">Feeling: </span>
                <span className="font-medium capitalize">{profile.emotional_state}</span>
              </div>
            )}

            {/* Score bars */}
            <div className="space-y-2">
              <ScoreBar label="Trust" value={profile.rapport_score} color="bg-green-500" />
              <ScoreBar label="Motivation" value={profile.motivation_level} color="bg-blue-500" />
              <ScoreBar label="Anxiety" value={profile.anxiety_level} color="bg-amber-500" />
              <ScoreBar label="Confidence" value={profile.confidence_level} color="bg-purple-500" />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pain Points & Objections */}
      {profile && (profile.pain_points?.length > 0 || profile.objections?.length > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              <Target className="h-3.5 w-3.5 text-red-500" />
              Pain Points & Objections
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Pain points */}
            {profile.pain_points?.length > 0 && (
              <div className="space-y-1.5">
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Pain Points</span>
                {profile.pain_points.slice(0, 3).map((p, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-xs">
                    <AlertTriangle className="h-3 w-3 text-amber-500 mt-0.5 shrink-0" />
                    <span>{p.point}</span>
                    <Badge variant="outline" className="text-[9px] ml-auto shrink-0">
                      {p.severity}/10
                    </Badge>
                  </div>
                ))}
              </div>
            )}

            {profile.objections?.length > 0 && (
              <>
                <Separator />
                <div className="space-y-1.5">
                  <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Objections</span>
                  {profile.objections.slice(0, 4).map((o, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-xs">
                      {o.addressed ? (
                        <CheckCircle2 className="h-3 w-3 text-green-500 mt-0.5 shrink-0" />
                      ) : (
                        <AlertTriangle className="h-3 w-3 text-red-500 mt-0.5 shrink-0" />
                      )}
                      <span className={o.addressed ? 'line-through text-muted-foreground' : ''}>
                        {o.objection}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Next Best Action */}
      {profile?.next_best_action && (
        <Card className="border-green-200 bg-green-50/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5 text-green-800">
              <Zap className="h-3.5 w-3.5" />
              Pick Up From Here
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-green-700 leading-relaxed">
              {profile.next_best_action}
            </p>
            {profile.recommended_tone && (
              <div className="mt-2 flex items-center gap-1.5 text-[10px] text-green-600">
                <TrendingUp className="h-3 w-3" />
                Tone: {profile.recommended_tone}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Key Moments Timeline */}
      {profile?.key_moments && profile.key_moments.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-blue-500" />
              Key Moments
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {profile.key_moments.slice(-5).reverse().map((m, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <div className={`mt-1 h-1.5 w-1.5 rounded-full shrink-0 ${
                    m.type === 'breakthrough' ? 'bg-green-500' :
                    m.type === 'setback' ? 'bg-red-500' :
                    m.type === 'connection' ? 'bg-blue-500' :
                    'bg-gray-400'
                  }`} />
                  <div>
                    <p className="text-muted-foreground">{m.description}</p>
                    <span className="text-[10px] text-muted-foreground/60">{m.date}</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
