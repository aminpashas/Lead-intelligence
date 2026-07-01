'use client'

import { useEffect, useState } from 'react'
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

function ScoreBar({ label, value, max = 10, accent = false }: { label: string; value: number; max?: number; accent?: boolean }) {
  const pct = Math.min((value / max) * 100, 100)
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[11px]">
        <span className="text-aurea-ink-3">{label}</span>
        <span className="font-mono tabular-nums text-aurea-ink-2">{value}/{max}</span>
      </div>
      <div className="h-[3px] w-full overflow-hidden rounded-full bg-aurea-surface-2">
        <div
          className={accent ? 'h-full rounded-full bg-aurea-amber' : 'h-full rounded-full bg-aurea-primary'}
          style={{ width: `${pct}%` }}
        />
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
      <div className="aurea-card p-5">
        <div className="flex items-center gap-2 mb-3">
          <Brain className="h-[17px] w-[17px] text-aurea-primary" strokeWidth={1.75} />
          <h3 className="aurea-display text-[16px] text-aurea-ink">Patient Summary</h3>
        </div>
        <div className="flex items-center justify-center py-6">
          <Loader2 className="h-4 w-4 animate-spin text-aurea-ink-3" />
        </div>
      </div>
    )
  }

  const profile = data?.profile

  return (
    <div className="space-y-4">
      {/* AI Summary Card */}
      <div className="aurea-card overflow-hidden">
        <div className="flex items-center gap-2 border-b border-aurea-border px-5 py-4">
          <Brain className="h-[17px] w-[17px] text-aurea-primary" strokeWidth={1.75} />
          <h3 className="aurea-display text-[18px] text-aurea-ink">Patient Summary</h3>
        </div>
        <div className="space-y-3 p-5">
          {profile?.ai_summary ? (
            <p className="text-[12.5px] leading-relaxed text-aurea-ink-2">
              {profile.ai_summary}
            </p>
          ) : (
            <p className="text-[12.5px] text-aurea-ink-3 italic">
              No AI analysis yet. Analyze a conversation to build the patient profile.
            </p>
          )}

          {/* Agent indicator */}
          {data?.active_agent && data.active_agent !== 'none' && (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-aurea-ink-3">Active agent:</span>
              <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-medium ${
                data.active_agent === 'setter'
                  ? 'border-aurea-border bg-aurea-surface-2 text-aurea-ink-2'
                  : 'border-aurea-primary/20 bg-aurea-primary/10 text-aurea-primary'
              }`}>
                {data.active_agent === 'setter' ? 'Setter' : 'Closer'}
              </span>
            </div>
          )}

          {/* Quick stats */}
          <div className="flex gap-3 text-[11px] text-aurea-ink-3">
            <div className="flex items-center gap-1">
              <MessageSquare className="h-3 w-3" strokeWidth={1.75} />
              <span className="font-mono tabular-nums">{lead.total_messages_sent + lead.total_messages_received}</span> msgs
            </div>
            {profile?.total_conversations_analyzed ? (
              <div className="flex items-center gap-1">
                <Brain className="h-3 w-3" strokeWidth={1.75} />
                <span className="font-mono tabular-nums">{profile.total_conversations_analyzed}</span> analyzed
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Emotional State & Scores */}
      {profile && profile.personality_type && (
        <div className="aurea-card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-aurea-border px-5 py-4">
            <Heart className="h-[17px] w-[17px] text-aurea-rose" strokeWidth={1.75} />
            <h3 className="aurea-display text-[18px] text-aurea-ink">Emotional Pulse</h3>
          </div>
          <div className="space-y-3 p-5">
            {/* Personality */}
            <div className="flex items-center gap-2">
              <span className="inline-flex rounded border border-aurea-border bg-aurea-surface-2 px-2 py-0.5 text-[10.5px] font-medium capitalize text-aurea-ink-2">
                {profile.personality_type}
              </span>
              {profile.communication_style && (
                <span className="text-[11px] text-aurea-ink-3 capitalize">
                  {profile.communication_style}
                </span>
              )}
            </div>

            {/* Emotional state */}
            {profile.emotional_state && (
              <div className="text-[12px]">
                <span className="text-aurea-ink-3">Feeling: </span>
                <span className="font-medium text-aurea-ink capitalize">{profile.emotional_state}</span>
              </div>
            )}

            {/* Score bars */}
            <div className="space-y-2.5">
              <ScoreBar label="Trust" value={profile.rapport_score} />
              <ScoreBar label="Motivation" value={profile.motivation_level} />
              <ScoreBar label="Anxiety" value={profile.anxiety_level} accent />
              <ScoreBar label="Confidence" value={profile.confidence_level} />
            </div>
          </div>
        </div>
      )}

      {/* Pain Points & Objections */}
      {profile && (profile.pain_points?.length > 0 || profile.objections?.length > 0) && (
        <div className="aurea-card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-aurea-border px-5 py-4">
            <Target className="h-[17px] w-[17px] text-aurea-rose" strokeWidth={1.75} />
            <h3 className="aurea-display text-[18px] text-aurea-ink">Pain Points &amp; Objections</h3>
          </div>
          <div className="space-y-3 p-5">
            {/* Pain points */}
            {profile.pain_points?.length > 0 && (
              <div className="space-y-1.5">
                <p className="aurea-eyebrow">Pain Points</p>
                {profile.pain_points.slice(0, 3).map((p, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-[12.5px]">
                    <AlertTriangle className="h-3 w-3 text-aurea-amber mt-0.5 shrink-0" strokeWidth={1.75} />
                    <span className="text-aurea-ink-2">{p.point}</span>
                    <span className="font-mono text-[10px] text-aurea-ink-3 ml-auto shrink-0">
                      {p.severity}/10
                    </span>
                  </div>
                ))}
              </div>
            )}

            {profile.objections?.length > 0 && (
              <>
                <Separator />
                <div className="space-y-1.5">
                  <p className="aurea-eyebrow">Objections</p>
                  {profile.objections.slice(0, 4).map((o, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-[12.5px]">
                      {o.addressed ? (
                        <CheckCircle2 className="h-3 w-3 text-aurea-primary mt-0.5 shrink-0" strokeWidth={1.75} />
                      ) : (
                        <AlertTriangle className="h-3 w-3 text-aurea-rose mt-0.5 shrink-0" strokeWidth={1.75} />
                      )}
                      <span className={o.addressed ? 'line-through text-aurea-ink-3' : 'text-aurea-ink-2'}>
                        {o.objection}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Next Best Action */}
      {profile?.next_best_action && (
        <div className="aurea-card overflow-hidden border-aurea-primary/20">
          <div className="flex items-center gap-2 border-b border-aurea-border px-5 py-4">
            <Zap className="h-[17px] w-[17px] text-aurea-primary" strokeWidth={1.75} />
            <h3 className="aurea-display text-[18px] text-aurea-ink">Pick Up From Here</h3>
          </div>
          <div className="p-5">
            <p className="text-[12.5px] text-aurea-ink-2 leading-relaxed">
              {profile.next_best_action}
            </p>
            {profile.recommended_tone && (
              <div className="mt-2.5 flex items-center gap-1.5 text-[11px] text-aurea-primary">
                <TrendingUp className="h-3 w-3" strokeWidth={1.75} />
                Tone: {profile.recommended_tone}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Key Moments Timeline */}
      {profile?.key_moments && profile.key_moments.length > 0 && (
        <div className="aurea-card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-aurea-border px-5 py-4">
            <Clock className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
            <h3 className="aurea-display text-[18px] text-aurea-ink">Key Moments</h3>
          </div>
          <div className="p-5">
            <div className="space-y-2.5">
              {profile.key_moments.slice(-5).reverse().map((m, i) => (
                <div key={i} className="flex items-start gap-2.5 text-[12px]">
                  <div className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${
                    m.type === 'breakthrough' ? 'bg-aurea-primary' :
                    m.type === 'setback'      ? 'bg-aurea-rose' :
                    m.type === 'connection'   ? 'bg-aurea-ink-2' :
                    'bg-aurea-ink-3'
                  }`} />
                  <div>
                    <p className="text-aurea-ink-2">{m.description}</p>
                    <span className="font-mono text-[10px] text-aurea-ink-3">{m.date}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
